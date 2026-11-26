#!/usr/bin/env bash
set -uo pipefail

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
ROS_SETUP="${LIMO_ROS_SETUP:-$HOME/limo_ros2_ws/install/setup.bash}"
SERVER_IP="${LIMO_SERVER_IP:-192.168.1.101}"
ROBOT_IP="${LIMO_ROBOT_IP:-}"
CAMERA_DEVICE="${LIMO_CAMERA_DEVICE:-/dev/video0}"

run_component() {
  local component="$1"

  if [[ ! -f "$ROS_SETUP" ]]; then
    echo "Não encontrei o ambiente ROS: $ROS_SETUP"
    return 1
  fi

  source "$ROS_SETUP" || {
    echo "Falhou o carregamento do ambiente ROS: $ROS_SETUP"
    return 1
  }

  export ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-2}"
  export RMW_IMPLEMENTATION="${RMW_IMPLEMENTATION:-rmw_cyclonedds_cpp}"
  export ROS_LOCALHOST_ONLY="${ROS_LOCALHOST_ONLY:-0}"

  case "$component" in
    rosbridge)
      ros2 launch rosbridge_server rosbridge_websocket_launch.xml \
        address:=0.0.0.0 port:=9090
      ;;
    bringup)
      ros2 launch limo_bringup limo_start.launch.py
      ;;
    camera)
      if ! command -v ffmpeg >/dev/null 2>&1; then
        echo 'Não encontrei o FFmpeg.'
        return 1
      fi

      if [[ ! -e "$CAMERA_DEVICE" ]]; then
        echo "Não encontrei a câmara em $CAMERA_DEVICE."
        return 1
      fi

      ffmpeg -f v4l2 -input_format mjpeg -video_size 640x480 \
        -framerate 15 -i "$CAMERA_DEVICE" -an -c:v copy -f rtp \
        "rtp://${SERVER_IP}:5004"
      ;;
    *)
      echo "Processo desconhecido: $component"
      return 2
      ;;
  esac

  local result=$?
  echo "O processo '$component' terminou (código $result)."
  return "$result"
}

if [[ "${1:-}" == '--run' ]]; then
  run_component "${2:-}"
  exit $?
fi

usage() {
  cat <<'EOF'
Uso:
  ./start-limo.sh --robot-ip IP_DO_ROBO [--server-ip IP_DO_PC]

Opções:
  --robot-ip IP
  --server-ip IP
  --camera-device DEV
EOF
}

while (($#)); do
  case "$1" in
    --robot-ip)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      ROBOT_IP="$2"
      shift 2
      ;;
    --server-ip)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      SERVER_IP="$2"
      shift 2
      ;;
    --camera-device)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      CAMERA_DEVICE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Opção desconhecida: $1"
      usage
      exit 2
      ;;
  esac
done

if [[ -z "$ROBOT_IP" ]]; then
  echo 'Indica o IP do robô com --robot-ip.'
  usage
  exit 2
fi

if [[ ! -f "$ROS_SETUP" ]]; then
  echo "Não encontrei o ambiente ROS: $ROS_SETUP"
  exit 1
fi

if ! command -v tmux >/dev/null 2>&1; then
  echo 'O tmux não está instalado.'
  echo 'Instala com: sudo apt install tmux'
  exit 1
fi

if command -v ip >/dev/null 2>&1; then
  route_source="$(ip -o route get "$SERVER_IP" 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") {print $(i + 1); exit}}')"

  if [[ -n "$route_source" && "$route_source" != "$ROBOT_IP" ]]; then
    echo "Aviso: a rota usa ${route_source}, mas o IP registado é ${ROBOT_IP}."
  fi
fi

SESSION="limo-${ROBOT_IP//./-}"

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Já existe uma sessão para este robô: $SESSION"
  echo "Consulta com: tmux attach -t $SESSION"
  echo "Para parar: tmux kill-session -t $SESSION"
  exit 1
fi

export LIMO_SERVER_IP="$SERVER_IP"
export LIMO_ROBOT_IP="$ROBOT_IP"
export LIMO_CAMERA_DEVICE="$CAMERA_DEVICE"
export LIMO_ROS_SETUP="$ROS_SETUP"
export ROS_DOMAIN_ID="${ROS_DOMAIN_ID:-2}"
export RMW_IMPLEMENTATION="${RMW_IMPLEMENTATION:-rmw_cyclonedds_cpp}"
export ROS_LOCALHOST_ONLY="${ROS_LOCALHOST_ONLY:-0}"

create_command() {
  local component="$1"

  printf -v command \
    'env LIMO_SERVER_IP=%q LIMO_ROBOT_IP=%q LIMO_CAMERA_DEVICE=%q LIMO_ROS_SETUP=%q ROS_DOMAIN_ID=%q RMW_IMPLEMENTATION=%q ROS_LOCALHOST_ONLY=%q bash %q --run %q' \
    "$SERVER_IP" "$ROBOT_IP" "$CAMERA_DEVICE" "$ROS_SETUP" \
    "$ROS_DOMAIN_ID" "$RMW_IMPLEMENTATION" "$ROS_LOCALHOST_ONLY" \
    "$SCRIPT_PATH" "$component"

  echo "$command"
}

echo "A iniciar LIMO ${ROBOT_IP}..."
echo "Servidor: ${SERVER_IP}"

tmux new-session -d -s "$SESSION" -n rosbridge \
  "$(create_command rosbridge)" || exit 1

tmux new-window -t "$SESSION" -n bringup \
  "$(create_command bringup)" || exit 1

tmux new-window -t "$SESSION" -n camera \
  "$(create_command camera)" || exit 1

echo
echo "Os três processos foram iniciados."
echo
echo "Sessão: $SESSION"
echo "Consultar: tmux attach -t $SESSION"
echo "Parar:     tmux kill-session -t $SESSION"
echo
