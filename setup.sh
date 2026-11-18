#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ -e .env ]]; then
  echo '.env 已存在；为保护现有配置，未覆盖。请手动编辑后执行 docker compose up -d --build。'
  exit 1
fi
command -v docker >/dev/null || { echo '请先安装 Docker Engine 和 Compose 插件，见 DEPLOY.md。'; exit 1; }
docker compose version >/dev/null
command -v openssl >/dev/null || { echo '需要 openssl 来生成随机密码。'; exit 1; }
read -rp '网站域名（例如 voice.example.com，不带 https://）：' site_domain
read -rp '服务器公网 IPv4：' rtc_address
read -rp '证书通知邮箱：' acme_email
[[ "$site_domain" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ && "$site_domain" == *.* ]] || { echo '域名格式无效'; exit 1; }
[[ "$rtc_address" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || { echo 'IPv4 格式无效'; exit 1; }
IFS='.' read -r -a octets <<< "$rtc_address"
for octet in "${octets[@]}"; do ((10#$octet <= 255)) || { echo 'IPv4 范围无效'; exit 1; }; done
[[ "$acme_email" =~ ^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]] || { echo '邮箱格式无效'; exit 1; }
admin_password=$(openssl rand -hex 18)
invite_code=$(openssl rand -hex 12)
umask 077
cat > .env <<EOF
SITE_DOMAIN=$site_domain
ACME_EMAIL=$acme_email
NODE_ENV=production
PUBLIC_ORIGIN=https://$site_domain
RTC_ANNOUNCED_ADDRESS=$rtc_address
RTC_LISTEN_IP=0.0.0.0
RTC_PORT=40000
ADMIN_USERNAME=admin
ADMIN_PASSWORD=$admin_password
INVITE_CODE=$invite_code
MAX_VOICE_USERS=8
MAX_ROOM_USERS=8
MAX_CONNECTIONS=40
MAX_USERS=100
TURN_URLS=
TURN_SECRET=
EOF
echo "配置已生成。首次管理员：admin，密码保存在 .env 的 ADMIN_PASSWORD。"
echo "邀请码保存在 .env 的 INVITE_CODE。请妥善保管，不要提交 GitHub。"
echo '请确认域名解析和端口已放行，然后执行：docker compose up -d --build'
