# Фаза 3 — деплой. Пошагово

Всё, что ниже, выполняется по порядку. Каждый шаг заканчивается проверкой — если она не прошла, дальше идти нельзя, следующий шаг построится на сломанном.

Обозначения: `[локально]` — на девбоксе `185.194.140.152`, `[сервер]` — на новой машине.

---

## 0. Что понадобится заранее

- Аккаунт Hetzner Cloud (или другой провайдер, спека ниже)
- Домен и доступ к его DNS
- SSH-ключ. Проверить, что он есть:

```bash
ls -la ~/.ssh/id_ed25519.pub
```

Если нет — создать:

```bash
ssh-keygen -t ed25519 -C "poolitzer"
```

---

## 1. Поднять машину

**Hetzner Cloud → Add Server:**

| Параметр | Значение |
|---|---|
| Location | Nuremberg или Helsinki |
| Image | Ubuntu 24.04 |
| Type | **CX22** (2 vCPU, 4 ГБ, 40 ГБ) |
| Networking | IPv4 включён |
| SSH keys | **вставить свой публичный ключ прямо здесь** |
| Name | poolitzer |

Ключ обязательно вставить на этапе создания. Иначе Hetzner пришлёт рутовый пароль почтой и придётся менять его через консоль.

**Проверка:**

```bash
ssh root@СЕРВЕР_IP "echo ok && lsb_release -ds && nproc && free -g | head -2 && df -h / | tail -1"
```

Ожидаем `ok`, `Ubuntu 24.04`, `2`, около 4 ГБ памяти и ~40 ГБ диска.

---

## 2. DNS

В панели домена добавить запись:

```
Тип:  A
Имя:  poolitzer   (или @ для корня домена)
Value: СЕРВЕР_IP
TTL:   авто
```

**У Cloudflare — обязательно серое облако (DNS only), не оранжевое.** С проксированием Caddy не сможет получить сертификат обычным способом, придётся возиться с DNS-челленджем и API-токеном. Включить проксирование можно потом.

**Проверка** (может занять до пары минут):

```bash
dig +short poolitzer.ТВОЙ-ДОМЕН
```

Должен вернуться IP сервера. Пока не вернулся — дальше не идти, шаг 7 упрётся именно в это.

---

## 3. Пользователь и базовая защита

`[сервер]`, под root:

```bash
adduser --disabled-password --gecos "" poolitzer
install -d -m 700 -o poolitzer -g poolitzer /home/poolitzer/.ssh
cp /root/.ssh/authorized_keys /home/poolitzer/.ssh/
chown poolitzer:poolitzer /home/poolitzer/.ssh/authorized_keys
chmod 600 /home/poolitzer/.ssh/authorized_keys
```

Запретить вход root по SSH и вход по паролю:

```bash
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh
```

Файрвол — наружу только SSH и веб:

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status
```

**Проверка.** Не закрывая текущую сессию, открыть новое окно терминала:

```bash
ssh poolitzer@СЕРВЕР_IP "whoami && sudo -n true 2>&1 | head -1"
```

Должно вывести `poolitzer`. Порт 4663 снаружи должен быть закрыт — проверим на шаге 8.

Если новая сессия не пускает — **не закрывать старую**, чинить из неё.

---

## 4. Node 22

Ubuntu 24.04 везёт Node 18, а проект требует 22.6+, потому что исполняет TypeScript напрямую без сборки.

`[сервер]`, под root:

```bash
apt-get update
apt-get install -y curl ca-certificates git
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
```

**Проверка:**

```bash
node --version
node -e "console.log(process.features.typescript)"
```

Ожидаем `v22.x` (не ниже 22.6) и `strip`. Если второе пусто — Node не умеет исполнять `.ts` и ничего не запустится.

---

## 5. Репозиторий

`[сервер]`, под пользователем `poolitzer`:

```bash
su - poolitzer
git clone https://github.com/Artemoon13/Poolitzer-.git poolitzer
cd poolitzer
npm install
```

Конфиг:

```bash
cp .env.example .env
```

Открыть `.env` и выставить три строки — они и делают запуск безопасным:

```
BOARD_HOST=127.0.0.1
TRUST_PROXY=1
BOARD_PORT=4663
```

`BOARD_HOST=127.0.0.1` — доска слушает только локально, единственная дверь снаружи это Caddy.
`TRUST_PROXY=1` — иначе rate limit увидит все запросы как приходящие от Caddy, то есть с одного адреса, и посчитает весь интернет одним клиентом.

**Проверка:**

```bash
npm run doctor
```

Все строки должны быть `ok`. Если падает на эндпоинтах — дальше бессмысленно.

---

## 6. Данные

Два варианта. Первый быстрее, второй чище.

### Вариант А — перелить готовую базу (~187 МБ, пара минут)

SQLite пишет в WAL-файл рядом с базой. Копировать базу, пока в неё пишут, нельзя — приедет обрезанная. Поэтому сначала остановить писателей и слить WAL в основной файл.

`[локально]`:

```bash
pkill -f "src/cli/watch.ts"
pkill -f "src/cli/enrich"
sleep 2
node --no-warnings -e '
const { openDb } = await import("./src/db.ts");
const db = openDb();
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
db.close();
console.log("WAL слит в базу");
'
ls -la data/
```

`data/poolitzer.db-wal` должен стать нулевого размера. Теперь копировать:

```bash
scp data/poolitzer.db poolitzer@СЕРВЕР_IP:~/poolitzer/data/poolitzer.db
```

### Вариант Б — собрать на месте (~7 минут)

```bash
npm run setup
```

Медленнее, но заодно проверяет, что установка с нуля работает — а это мы всё равно обещаем в README.

**Проверка** `[сервер]`:

```bash
npm run stats
```

Должны увидеть сотни тысяч запусков и градуации. Если база пустая — копия не доехала.

---

## 7. systemd

Три процесса. `[сервер]`, под root.

**Доска** — `/etc/systemd/system/poolitzer-board.service`:

```ini
[Unit]
Description=poolitzer board
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=poolitzer
WorkingDirectory=/home/poolitzer/poolitzer
ExecStart=/usr/bin/node --no-warnings src/board.ts
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

**Вотчер** — `/etc/systemd/system/poolitzer-watch.service`:

```ini
[Unit]
Description=poolitzer live watcher
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=poolitzer
WorkingDirectory=/home/poolitzer/poolitzer
ExecStart=/usr/bin/node --no-warnings src/cli/watch.ts
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

**Ночное переобучение** — `/etc/systemd/system/poolitzer-nightly.service`:

```ini
[Unit]
Description=poolitzer nightly retrain

[Service]
Type=oneshot
User=poolitzer
WorkingDirectory=/home/poolitzer/poolitzer
ExecStart=/usr/bin/npm run nightly
```

и таймер `/etc/systemd/system/poolitzer-nightly.timer`:

```ini
[Unit]
Description=poolitzer nightly retrain

[Timer]
OnCalendar=*-*-* 04:30:00
Persistent=true

[Install]
WantedBy=timers.target
```

`Persistent=true` — если машина была выключена в 04:30, задание отработает после включения, а не пропустится молча.

Включить:

```bash
systemctl daemon-reload
systemctl enable --now poolitzer-board poolitzer-watch poolitzer-nightly.timer
systemctl status poolitzer-board poolitzer-watch --no-pager
```

**Проверка:**

```bash
curl -s localhost:4663/api/health
```

Ждём `watcherSeenSecAgo` в пределах пары секунд и небольшое `behindSec`. Если `watcherSeenSecAgo` равно `null` — вотчер не стартовал, смотреть `journalctl -u poolitzer-watch -n 50`.

---

## 8. Caddy и TLS

`[сервер]`, под root:

```bash
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy
```

`/etc/caddy/Caddyfile` — целиком заменить на:

```
poolitzer.ТВОЙ-ДОМЕН {
	encode zstd gzip
	reverse_proxy 127.0.0.1:4663
}
```

```bash
systemctl reload caddy
journalctl -u caddy -n 30 --no-pager
```

Сертификат Caddy получает сам за несколько секунд. В логе должно быть `certificate obtained successfully`.

**Проверка** `[локально]`:

```bash
curl -sI https://poolitzer.ТВОЙ-ДОМЕН | head -3
curl -s https://poolitzer.ТВОЙ-ДОМЕН/api/health
```

И отдельно — что прямой порт закрыт снаружи:

```bash
curl -s -m 5 http://СЕРВЕР_IP:4663/api/health && echo "ПЛОХО: порт открыт наружу" || echo "хорошо: порт закрыт"
```

---

## 9. Прогон

**Rate limit** `[локально]`:

```bash
for i in $(seq 1 70); do
  curl -s -o /dev/null -w "%{http_code}\n" https://poolitzer.ТВОЙ-ДОМЕН/api/health
done | sort | uniq -c
```

Ожидаем примерно 60 ответов `200` и остальные `429`. Если все 70 прошли — не подхватился `TRUST_PROXY=1`, проверить `.env` и перезапустить доску.

**Переживает ли ребут:**

```bash
ssh poolitzer@СЕРВЕР_IP "sudo reboot"
sleep 45
curl -s https://poolitzer.ТВОЙ-ДОМЕН/api/health
```

Должно ответить без ручного вмешательства. Это главная проверка всего шага 7.

**Лог предсказаний наполняется** `[сервер]`, через несколько минут после старта:

```bash
cd ~/poolitzer && npm run scoreboard
```

Первые оценённые claims появятся через 4 часа — столько настаивается горизонт. До этого команда честно скажет, сколько заявок ждёт своей очереди.

**Финальный чеклист:**

- [ ] `https://poolitzer.ТВОЙ-ДОМЕН` открывается, сертификат валидный
- [ ] Лента заполнена, возраст верхних запусков — секунды или минуты
- [ ] Плашки про отставание нет (или жёлтая, если догоняет)
- [ ] Переключатель `by chance` / `newest` работает
- [ ] Карточка открывается мгновенно, адрес контракта копируется
- [ ] Порт 4663 снаружи закрыт
- [ ] После ребута всё поднялось само

---

## Если что-то сломалось

```bash
journalctl -u poolitzer-board -n 100 --no-pager     # доска
journalctl -u poolitzer-watch -f                    # вотчер, живой лог
journalctl -u caddy -n 50 --no-pager              # сертификаты и проксирование
systemctl list-timers poolitzer-nightly.timer       # когда следующее переобучение
```

**Доска отвечает, но лента пустая.** Нет модели или нет данных за последние 6 часов. Проверить `ls -la data/model.json` и `npm run stats`.

**Красная плашка «watcher has not reported».** Вотчер упал или не может достучаться до RPC. `journalctl -u poolitzer-watch -n 50`.

**Caddy не берёт сертификат.** Почти всегда DNS: либо запись ещё не разошлась, либо у Cloudflare включено проксирование. Проверить `dig +short`.

**Всё встало через несколько дней.** Скорее всего публичный RPC. Это известный и принятый риск: `eth_getLogs` на этой цепи отдаёт ровно один публичный эндпоинт, запасного нет. `npm run doctor` покажет.

---

## Что осталось за рамками этого шага

Сознательно отложено, чтобы не делать в ночь деплоя:

- **Чистка старых данных.** База растёт на ~26 МБ в сутки, 40 ГБ хватит года на три. Но политику надо завести.
- **Запасной RPC.** Надо выяснить, существуют ли платные провайдеры для Robinhood Chain. Пока продукт висит на чужом бесплатном эндпоинте.
- **Скорборд отдельной страницей.** Сейчас только CLI. Смысл появится, когда в логе накопятся оценённые предсказания — то есть через сутки-другие после запуска.
- **Мониторинг.** Ничего не разбудит ночью, если сервис встанет. Минимум — внешняя проверка `/api/health` раз в пять минут.
