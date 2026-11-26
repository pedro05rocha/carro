# Configuração do LIMO e validação da monitorização

## Iniciar um robô

Copia `scripts/start-limo.sh` do projeto para cada robô. No ambiente gráfico de cada LIMO, executa o script indicando o IP do próprio robô e o IP do computador onde corre o backend. O script abre três terminais independentes para rosbridge, bringup e câmara. Cada terminal carrega o workspace ROS e usa o mesmo `ROS_DOMAIN_ID`, `RMW_IMPLEMENTATION` e `ROS_LOCALHOST_ONLY`.

Exemplo para o primeiro robô:

```bash
chmod +x ~/start-limo.sh
~/start-limo.sh --robot-ip 192.168.1.105 --server-ip 192.168.1.101
```

No segundo robô, executa o mesmo comando com o IP do segundo LIMO, por exemplo `--robot-ip 192.168.1.106`. O IP deve coincidir com o registado em **Gestão de robôs** no Grafana. O endereço de vídeo continua a ser o mesmo para todos os robôs (`IP_DO_PC:5004`); o backend separa os fluxos pelo IP de origem.

O IP do servidor tem como predefinição `192.168.1.101`; altera `--server-ip` se necessário. Para outra câmara, usa `--camera-device /dev/video1`, por exemplo. O caminho do workspace predefinido é `~/limo_ros2_ws/install/setup.bash`; para alterá-lo, define `LIMO_ROS_SETUP` antes de iniciar o script. É necessário ter `ffmpeg`, o workspace ROS e um terminal gráfico instalados. Se faltar FFmpeg, instala com `sudo apt install ffmpeg`. Por SSH sem ambiente gráfico, o script não consegue abrir as três janelas.

## Rosbridge em Foxy

O ROS Index lista `rosbridge_suite` e `rosbridge_server` na distribuição Foxy. Foxy terminou o suporte upstream; usa pacotes compilados para essa distribuição e testa no robô antes de operação.

No LIMO:

```bash
source ~/limo_ros2_ws/install/setup.bash
export ROS_DOMAIN_ID=2
export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
export ROS_LOCALHOST_ONLY=0
sudo apt update
sudo apt install ros-foxy-rosbridge-suite
ros2 launch rosbridge_server rosbridge_websocket_launch.xml address:=0.0.0.0 port:=9090
```

Se o binário apt não existir no repositório Foxy configurado, compila o branch Foxy do repositório oficial e confirma os argumentos da launch file com `--show-args`. A porta 9090 deve ser acessível apenas pelo backend ou por VPN; não a encaminhes para a Internet.

Antes de conectar o dashboard, verifica no LIMO:

```bash
ros2 topic list -t
ros2 topic info /scan
ros2 topic info /imu
ros2 topic info /odom
ros2 topic info /limo_status
ros2 topic info /cmd_vel
ros2 interface show limo_msgs/msg/LimoStatus
```

Confirma que os tipos correspondem a `sensor_msgs/msg/LaserScan`, `sensor_msgs/msg/Imu`, `nav_msgs/msg/Odometry`, `limo_msgs/msg/LimoStatus` e `geometry_msgs/msg/Twist`.

## Iniciar Grafana e Prometheus

Na raiz do projeto, configura o `.env` com credenciais próprias e inicia o stack:

```bash
cp .env.example .env
# Edita .env: define palavras-passe fortes e um LIMO_SECRET_KEY aleatório
docker compose up -d --build
```

O Grafana fica em `http://localhost:3000`. Entra com `GRAFANA_ADMIN_USER` e `GRAFANA_ADMIN_PASSWORD` de `.env` e abre **PLATO · Consola LIMO**. A consola de operação está dentro do Grafana; “Mais detalhes” abre o dashboard de gráficos históricos **LIMO Fleet - Mais detalhes**.

### Opcional: enviar métricas para Grafana Cloud

Na stack Cloud, abre **Prometheus → Details** e copia o endpoint de remote write e o ID da instância. Cria um token de Access Policy com `metrics:write`. Depois, a partir da raiz do projeto:

```bash
cp backend/prometheus/prometheus-cloud.yml.example backend/prometheus/prometheus-cloud.yml
```

Edita o ficheiro copiado com o endpoint e ID, e guarda apenas o token (sem aspas) em `backend/prometheus/grafana-cloud-token`. Não partilhes o token nem o coloques no Git. Os ficheiros locais estão ignorados pelo Git. Ativa o envio para a Cloud com:

```bash
docker compose -f docker-compose.yml -f docker-compose.cloud.yml up -d --build
```

O Prometheus continua a guardar o histórico local e encaminha as amostras para a Cloud. O painel de controlo personalizado permanece no Grafana local; na Cloud podes consultar as métricas, mas este plugin não assinado não está disponível lá. Guia oficial: https://grafana.com/docs/grafana-cloud/send-data/metrics/metrics-prometheus/prometheus-config-examples/integration-guide/.

## Validar métricas

1. Confirma que os três serviços estão ativos: `docker compose ps`.
2. Confirma a resposta do backend: `curl http://localhost:8000/api/health`.
3. Confirma o endpoint Prometheus: `curl http://localhost:8000/metrics`. Deve conter séries `limo_robot_connected` e `limo_sensor_online`; sem robôs, ainda não existem métricas com labels de robô.
4. Adiciona o LIMO na aplicação e espera a ligação.
5. Confirma os tópicos recebidos no dashboard e abre o dashboard Grafana. Os dados podem demorar até alguns segundos a aparecer.
6. A métrica de sensor fica online apenas enquanto o tópico está a publicar (janela de frescura de 5 segundos). Para validar valores, compara com `ros2 topic echo` no robô.
7. Se Prometheus não recolher, consulta `http://localhost:3000` → **Connections → Data sources → Prometheus** e valida **Prometheus → Status → Targets** (o alvo configurado é `backend:8000`).

O vetor de ranges do LiDAR é resumido à distância mínima finita e positiva. Não é apropriado publicar cada feixe como série Prometheus; mantém a visualização bruta no painel ROS quando for implementada. O painel principal e o painel personalizado do Grafana mostram a mesma transmissão de câmara autenticada. O backend recebe RTP em UDP 5004, converte os fotogramas com FFmpeg e serve MJPEG; o emissor de vídeo no LIMO ainda tem de enviar para o endereço da máquina onde corre Docker. Sem esse emissor, a área da câmara mostra «À espera de vídeo RTP».

## Teste seguro de movimento

Faz o ensaio numa área segura, com as rodas suspensas inicialmente e E-stop físico acessível. Confirma o zero em `/cmd_vel` ao largar o botão, ao perder a lease e ao desligar o bridge. A paragem web depende do backend, da rede e do bridge; valida também um watchdog/deadman independente no controlador do robô antes de teste no chão.
