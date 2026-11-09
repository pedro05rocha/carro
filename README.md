# LIMO Fleet · Interface principal Grafana

Projeto web para operação da frota AgileX LIMO PRO. A interface principal é um dashboard do Grafana que abre diretamente com um painel personalizado para iniciar sessão, adicionar robôs por IP, ligar/desligar, selecionar o robô, comandar movimento e acionar paragem de emergência. Os painéis abaixo mostram o histórico e estado através de Prometheus. O backend FastAPI continua a validar autenticação, limites, lease exclusiva e timeout; o painel Grafana não publica diretamente no rosbridge.

## Fluxo

```text
LIMO ROS 2 → rosbridge → FastAPI (/metrics) → Prometheus → painéis Grafana
                                      ↑                         ↓
                              painel de controlo Grafana ←──────┘
```

O Grafana não recebe vetores ROS diretamente. O backend traduz valores reais para métricas numéricas: ligação e frescura dos sensores, velocidade, aceleração, tensão, distância mínima do LiDAR, comandos e paragens. O Prometheus recolhe a cada 2 segundos e mantém 30 dias de histórico. A seleção do robô no painel personalizado também define o filtro de robô usado nos gráficos do dashboard.

## Estrutura

```text
backend/app/main.py                    API autenticada e rosbridge
backend/app/metrics.py                 exportação das métricas
backend/Dockerfile                     imagem FastAPI
backend/prometheus/prometheus.yml      scrape e retenção
backend/grafana/provisioning/          datasource e dashboard provisionados
backend/grafana/dashboards/            painéis de histórico

grafana-plugin/pedro-limofleetcontrol-panel/  plugin React do Grafana para gerir e comandar

grafana/Dockerfile                     compila o plugin e cria a imagem Grafana

docker-compose.yml                     backend, Prometheus e Grafana
frontend/                               cliente React opcional/standalone
```

## Arranque no Ubuntu

Requisitos: Docker Engine com Docker Compose e Node.js 20+ (para o frontend standalone opcional).

1. Na raiz do projeto, cria o ficheiro local de credenciais:

```bash
cp .env.example .env
```

Edita `.env` e define palavras-passe fortes para `LIMO_ADMIN_PASSWORD` e `GRAFANA_ADMIN_PASSWORD`. Gera também um segredo para tokens:

```bash
openssl rand -hex 32
```

Cola esse valor em `LIMO_SECRET_KEY`. Não publiques `.env`.

2. Inicia backend, Prometheus e Grafana (a imagem compila também o painel/plugin personalizado):

```bash
docker compose up -d --build
```

3. Abre [http://localhost:3000](http://localhost:3000) e entra com `GRAFANA_ADMIN_USER` e `GRAFANA_ADMIN_PASSWORD`. O dashboard **LIMO Fleet - Telemetria** é a página inicial. O login do Grafana e a autenticação do operador são duas etapas distintas: no painel principal, inicia sessão com `LIMO_ADMIN_USER` e `LIMO_ADMIN_PASSWORD`.

O painel de operação dentro do Grafana permite adicionar um nome, IP e porta (9090 por defeito), ligar, escolher o robô e controlar o movimento. A seleção altera o filtro dos gráficos Grafana. O histórico pode demorar alguns segundos a aparecer após a primeira telemetria.

Para iniciar a aplicação React antiga em separado (opcional):

```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

A lista de robôs, dados Grafana e histórico Prometheus ficam em volumes persistentes. `docker compose down` pára os serviços sem apagar volumes; evita `docker compose down -v` se quiseres manter dados.

## Verificação local

```bash
docker compose ps
curl http://localhost:8000/api/health
curl http://localhost:8000/metrics
```

O endpoint `/metrics` é sem autenticação para o Prometheus o poder recolher, mas o Compose liga-o apenas a `127.0.0.1` no host e a rede interna do Docker. Grafana e API não estão publicados para outros computadores. Não exponhas a porta rosbridge 9090 à Internet.

## ROS 2 Foxy e rosbridge

A documentação ROS lista `rosbridge_suite` e `rosbridge_server` para Foxy. Foxy terminou o suporte upstream, por isso instala os pacotes Foxy no LIMO e valida a versão concreta. Referências: [ROS Index rosbridge_suite](https://index.ros.org/p/rosbridge_suite/), [ROS Index rosbridge_server](https://index.ros.org/p/rosbridge_server/) e manual [AgileX LIMO PRO Foxy](https://github.com/agilexrobotics/limo_pro_doc/blob/master/Limo%20Pro%20Ros2%20Foxy%20user%20manual%28EN%29.md).

No LIMO:

```bash
sudo apt update
sudo apt install ros-foxy-rosbridge-suite
source ~/limo_ros2_ws/install/setup.bash
export ROS_DOMAIN_ID=2
export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
export ROS_LOCALHOST_ONLY=0
ros2 launch rosbridge_server rosbridge_websocket_launch.xml address:=0.0.0.0 port:=9090
```

Se o pacote apt Foxy não existir na instalação, compila o branch Foxy oficial com `rosdep`. Restringe a firewall para permitir só a máquina backend/VPN. Confirma no LIMO os tópicos e tipos com:

```bash
ros2 topic list -t
ros2 topic info /scan
ros2 topic info /imu
ros2 topic info /odom
ros2 topic info /limo_status
ros2 topic info /cmd_vel
ros2 interface show limo_msgs/msg/LimoStatus
```

O dashboard pressupõe `sensor_msgs/msg/LaserScan`, `sensor_msgs/msg/Imu`, `nav_msgs/msg/Odometry`, `limo_msgs/msg/LimoStatus` e `geometry_msgs/msg/Twist`. O manual AgileX documenta `battery_voltage` no `LimoStatus`; confirma que o pacote instalado no LIMO usa esse schema.

## Segurança e limites

- O painel Grafana autentica-se no backend com JWT, guarda o token do operador no armazenamento local do navegador e chama a API FastAPI autenticada. Não publica ROS diretamente.
- Velocidades limitadas no backend: ±0,6 m/s e ±1,5 rad/s. A lease exclusiva expira após 800 ms sem renovação e o backend envia zero. O plugin renova enquanto uma seta está premida e envia zero ao largar.
- Paragem de emergência web encaminha Twist zero pelo backend ao robô selecionado. Continua dependente do servidor, rede e rosbridge; conserva um E-stop físico e deadman independente no robô.
- O vetor completo do LiDAR não é guardado como métricas Prometheus; o dashboard guarda apenas a distância mínima finita positiva. A imagem da Orbbec DaBai DC1 permanece indisponível até existir um tópico ROS confirmado.
- Se abrires Grafana por IP ou hostname diferente de `localhost`, define `CORS_ORIGINS` em `.env` para a origem exata do Grafana e ajusta a rede/HTTPS com uma VPN/reverse proxy. Não publiques portas para a Internet.

## Estado de validação

O painel/plugin foi gerado a partir da estrutura oficial de plugins Grafana e está integrado no dashboard provisionado. O dashboard JSON, código Python e configuração Compose foram verificados; o frontend React compila. O build local do plugin Grafana no Windows falha porque o binding nativo SWC não é carregado neste ambiente. A imagem Docker foi preparada para o compilar em Linux, mas o Docker Desktop desta sessão não está ativo. A validação final do plugin, Compose completo e controlo requer `docker compose up --build` num Ubuntu com Docker, depois ensaio real com o LIMO.
