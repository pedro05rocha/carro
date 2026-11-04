# LIMO Fleet Dashboard

Dashboard web para monitorização e controlo autenticado de vários AgileX LIMO PRO. A telemetria só é apresentada quando recebida do robô; a aplicação não cria dados simulados.

## Estrutura

```text
frontend/
  src/
    components/DashboardParts.jsx  # cartões, login e gestão da frota
    services/api.js                # API autenticada e comandos
    styles/dashboard.css           # interface responsiva
    App.jsx                        # composição do dashboard
    main.jsx
backend/
  app/main.py                      # API, rosbridge e interlocks de segurança
  app/__init__.py
  requirements.txt
docs/robot-setup.md                # configuração ROS e ensaio no LIMO
```

## Tecnologias

- Interface: React, Vite, JavaScript e CSS.
- Servidor: Python, FastAPI e WebSocket.
- Robô: ROS 2 Foxy e `rosbridge_suite`.

## Arranque local (Ubuntu)

Requer Python 3.10+ e Node.js 20+.

1. Crie o ambiente Python e configure credenciais a partir de `backend/.env.example` (o ficheiro de exemplo não é carregado automaticamente):

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export LIMO_ADMIN_USER=admin
export LIMO_ADMIN_PASSWORD='defina-uma-palavra-passe-forte'
export LIMO_SECRET_KEY="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

2. Noutro terminal, instale e inicie a interface:

```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

3. Abra <http://localhost:5173> e autentique com as credenciais definidas no servidor.

A lista de robôs é guardada em `backend/robots.json` (ou no caminho definido por `LIMO_DB`). O ficheiro é local e está excluído do controlo de versões. O frontend usa `VITE_API_URL` (em `frontend/.env`) para aceder ao servidor. Para uma instalação remota, use hostname acessível, TLS para HTTP e WebSocket, restrinja o acesso à VPN e ajuste `CORS_ORIGINS` no backend. Não encaminhe a porta 9090 para a Internet.

## Adicionar e selecionar robôs

1. Abra **Gestão de Robôs**.
2. Introduza nome, IP e porta WebSocket (9090 por defeito). O exemplo fornecido é `192.168.1.105`.
3. Prima **Adicionar e ligar**. O servidor tenta estabelecer a ligação e apresenta o estado; se o bridge não responder, o robô fica em erro.
4. Quando a ligação ficar ativa, o robô surge no seletor **Veículo** do topo e na lista de frota ligada. Selecione-o para consultar a telemetria e direcionar os controlos.

A interface apresenta estados indisponíveis como «—» ou «NO DATA». A vista da câmara também permanece indisponível até ser confirmado um tópico real da Orbbec DaBai DC1.

## ROS 2 Bridge no LIMO

A compatibilidade foi confirmada na indexação ROS: `rosbridge_suite` e `rosbridge_server` têm release para Foxy. Foxy já terminou o suporte upstream, pelo que se recomenda usar os pacotes/branch específicos de Foxy e validar no robô. Referências: [ROS Index rosbridge_suite](https://index.ros.org/p/rosbridge_suite/), [ROS Index rosbridge_server](https://index.ros.org/p/rosbridge_server/) e [AgileX LIMO PRO Foxy manual](https://github.com/agilexrobotics/limo_pro_doc/blob/master/Limo%20Pro%20Ros2%20Foxy%20user%20manual%28EN%29.md).

No LIMO, instale o pacote binário Foxy se estiver disponível no repositório configurado:

```bash
sudo apt update
sudo apt install ros-foxy-rosbridge-suite
```

Se o binário não estiver disponível, compile o branch Foxy de [RobotWebTools/rosbridge_suite](https://github.com/RobotWebTools/rosbridge_suite) numa instalação Foxy e resolva as dependências com `rosdep`. Não use o branch `ros2` atual sem verificar compatibilidade com Foxy.

Inicie o bridge:

```bash
source ~/limo_ros2_ws/install/setup.bash
export ROS_DOMAIN_ID=2
export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp
export ROS_LOCALHOST_ONLY=0
ros2 launch rosbridge_server rosbridge_websocket_launch.xml address:=0.0.0.0 port:=9090
```

A escuta em `0.0.0.0` permite ligações pela LAN, por isso restrinja a firewall ao backend ou à VPN. Para conferir os argumentos aceites pela versão instalada, execute `ros2 launch rosbridge_server rosbridge_websocket_launch.xml --show-args`.

Confirme no robô que os tópicos e tipos esperados estão ativos:

```bash
ros2 topic list -t
ros2 topic info /scan
ros2 topic info /imu
ros2 topic info /odom
ros2 topic info /limo_status
ros2 topic info /cmd_vel
ros2 interface show limo_msgs/msg/LimoStatus
```

O manual Foxy da AgileX documenta `LimoStatus` com `battery_voltage`, `vehicle_state`, `control_mode`, `error_code` e `motion_mode`. O frontend lê a tensão de `battery_voltage`; confirme que o pacote instalado usa a mesma interface.

## Controlos e segurança

- Os comandos passam pelo backend autenticado; o navegador não publica diretamente no rosbridge.
- O backend limita velocidade linear a ±0,6 m/s e angular a ±1,5 rad/s. Os sliders do painel permitem valores mais baixos.
- Uma lease exclusiva impede utilizadores concorrentes de controlar robôs simultaneamente. Enquanto uma seta é premida, a interface renova a lease; ao largar, publica velocidade zero. O watchdog do backend também envia zero quando a lease expira (800 ms).
- A paragem de emergência envia zero pelo servidor ao robô selecionado. O backend limpa a lease associada. Sem seleção, o endpoint pode parar todos os robôs.
- Integre também um watchdog/deadman no controlador do robô e mantenha acessível o botão físico de emergência. A paragem web depende do servidor, rede e rosbridge e não substitui uma paragem física independente.
- O dashboard apresenta posição simples recebida em `/odom`; não constrói um mapa. Latência de rede ainda não é medida e fica indicada como indisponível.

## Estado de validação

O frontend foi compilado para produção com Vite. Não houve acesso a um LIMO, à rede `192.168.1.105` ou ao ambiente Ubuntu/ROS. A comunicação real, os schemas concretos, a câmara e o comportamento físico dos controlos ainda precisam de ser ensaiados no robô. Os passos de validação estão em [docs/robot-setup.md](docs/robot-setup.md).
