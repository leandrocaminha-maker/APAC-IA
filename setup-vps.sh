#!/bin/bash
# ==============================================================================
# APAC-IA SALES — Script de Instalação Automática para VPS (AlmaLinux 9 / RHEL)
# ==============================================================================

set -e

echo "🚀 Iniciando configuração do servidor..."

# 1. Instalar repositório do Docker
echo "📦 Configurando repositório do Docker..."
dnf install -y dnf-utils
dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo

# 2. Instalar Docker CE e Docker Compose Plugin
echo "🐳 Instalando Docker e Docker Compose..."
dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# 3. Habilitar e iniciar Docker
echo "⚡ Iniciando serviço do Docker..."
systemctl start docker
systemctl enable docker

# 4. Clonar repositório se não existir
cd /var/www
if [ ! -d "/var/www/apac-ia-sales" ]; then
  echo "📥 Clonando repositório GitHub..."
  git clone https://github.com/leandrocaminha-maker/APAC-IA.git apac-ia-sales
fi

cd /var/www/apac-ia-sales

# 5. Criar .env a partir do .env.example se não existir
if [ ! -f ".env" ]; then
  echo "⚙️ Criando arquivo .env..."
  cp .env.example .env
fi

echo ""
echo "✅ Instalação concluída com sucesso!"
echo ""
echo "📌 Próximos passos:"
echo " 1. Edite o .env: nano /var/www/apac-ia-sales/.env"
echo " 2. Suba o sistema: cd /var/www/apac-ia-sales && docker compose up -d"
echo ""
