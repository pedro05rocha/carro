"""
LIMO Fleet API.

Telemetry and cmd_vel are proxied through this authenticated server.
The front camera is received through RTP and streamed to the dashboard
using MJPEG over HTTP.
"""

import asyncio
import ipaddress
import json
import os
import time
import uuid

from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta
from pathlib import Path

import jwt
import websockets

from fastapi import (
    FastAPI,
    HTTPException,
    WebSocket,
    WebSocketDisconnect,
    Depends,
    Response
)

from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.responses import StreamingResponse

from pydantic import BaseModel, Field, IPvAnyAddress
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from .metrics import REGISTRY, refresh_metrics, remove_robot_metrics, CMD_VEL_COMMANDS, CONTROL_KEY_PRESSES, EMERGENCY_STOPS


# ============================================================
# CONFIGURATION
# ============================================================

SECRET = os.getenv("LIMO_SECRET_KEY", "")

USER = os.getenv("LIMO_ADMIN_USER", "admin")
PASSWORD = os.getenv("LIMO_ADMIN_PASSWORD", "")

DB = Path(os.getenv("LIMO_DB", "./robots.json"))

security = HTTPBearer(auto_error=False)

# RTP camera configuration

CAMERA_HOST = os.getenv("LIMO_CAMERA_HOST", "0.0.0.0")
CAMERA_PORT = int(os.getenv("LIMO_CAMERA_PORT", "5004"))
CAMERA_LOCAL_PORT_START = int(os.getenv("LIMO_CAMERA_LOCAL_PORT_START", "15000"))

FFMPEG = os.getenv("FFMPEG_PATH", "ffmpeg")


# ROS 2 topics subscribed through rosbridge

TOPICS = {
    "/scan": "sensor_msgs/msg/LaserScan",
    "/imu": "sensor_msgs/msg/Imu",
    "/odom": "nav_msgs/msg/Odometry",
    "/limo_status": "limo_msgs/msg/LimoStatus"
}


# ============================================================
# GLOBAL STATE
# ============================================================

robots = {}

listeners = set()

lease = {
    "user": None,
    "robot": None,
    "until": 0
}

lock = asyncio.Lock()


# Camera state is indexed by the registered robot ID. RTP ingress on port 5004
# is demultiplexed by sender IP and forwarded to a private FFmpeg input port.
camera_frames = {}
camera_sequences = {}
camera_frame_at = {}
camera_last_packet_at = {}
camera_sender_ips = {}
camera_conditions = {}
camera_processes = {}
camera_worker_tasks = {}
camera_local_ports = {}
camera_router_transport = None
camera_next_local_port = CAMERA_LOCAL_PORT_START


# ============================================================
# DATA MODELS
# ============================================================

class Login(BaseModel):
    username: str
    password: str


class RobotIn(BaseModel):
    name: str = Field(min_length=1, max_length=48)
    host: IPvAnyAddress
    port: int = Field(default=9090, ge=1, le=65535)


class Move(BaseModel):
    linear: float = Field(ge=-0.6, le=0.6)
    angular: float = Field(ge=-1.5, le=1.5)
    key: str | None = Field(default=None, pattern=r'^(w|a|s|d|q|e|z|c|button|control)$')


class StopRequest(BaseModel):
    robot_id: str | None = None


# ============================================================
# DATABASE
# ============================================================

def persist():
    """
    Saves registered robots to the JSON database.
    """

    DB.parent.mkdir(parents=True, exist_ok=True)

    data = [
        {
            key: robot[key]
            for key in ("id", "name", "host", "port", "status")
        }
        for robot in robots.values()
    ]

    DB.write_text(
        json.dumps(data, indent=2),
        encoding="utf-8"
    )


# ============================================================
# AUTHENTICATION
# ============================================================

def claims(token):
    """
    Validates a JWT token and returns its claims.
    """

    try:
        return jwt.decode(
            token,
            SECRET,
            algorithms=["HS256"]
        )

    except Exception:
        raise HTTPException(
            status_code=401,
            detail="Sessão inválida ou expirada"
        )


async def user_dep(
    credentials: HTTPAuthorizationCredentials | None = Depends(security)
):
    """
    Authenticates HTTP requests.
    """

    if not credentials:
        raise HTTPException(
            status_code=401,
            detail="Autenticação necessária"
        )

    return claims(credentials.credentials)["sub"]


def make_token(user):
    """
    Creates an authentication token valid for 8 hours.
    """

    return jwt.encode(
        {
            "sub": user,
            "exp": datetime.now(timezone.utc) + timedelta(hours=8)
        },
        SECRET,
        algorithm="HS256"
    )


# ============================================================
# CAMERA RECEIVER
# ============================================================

def normalize_ip(value):
    try:
        return ipaddress.ip_address(str(value).split("%", 1)[0]).compressed
    except ValueError:
        return None


async def publish_camera_frame(robot_id, frame):
    """Store the latest frame for one robot and wake its MJPEG viewers."""
    condition = camera_conditions.setdefault(robot_id, asyncio.Condition())
    async with condition:
        camera_frames[robot_id] = frame
        camera_sequences[robot_id] = camera_sequences.get(robot_id, 0) + 1
        camera_frame_at[robot_id] = time.time()
        condition.notify_all()


async def camera_decoder(robot_id, local_port):
    """Decode the RTP packets already separated by the UDP ingress router."""
    while robot_id in robots:
        process = None
        try:
            command = [
                FFMPEG, "-hide_banner", "-loglevel", "error",
                "-fflags", "nobuffer", "-flags", "low_delay",
                "-protocol_whitelist", "file,udp,rtp",
                "-i", f"rtp://127.0.0.1:{local_port}?sources=127.0.0.1",
                "-an", "-c:v", "mjpeg", "-q:v", "5",
                "-f", "image2pipe", "pipe:1"
            ]
            process = await asyncio.create_subprocess_exec(
                *command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL
            )
            camera_processes[robot_id] = process
            buffer = bytearray()

            while True:
                chunk = await process.stdout.read(65536)
                if not chunk:
                    break
                buffer.extend(chunk)
                while True:
                    start = buffer.find(b"\xff\xd8")
                    if start == -1:
                        buffer.clear()
                        break
                    if start > 0:
                        del buffer[:start]
                    end = buffer.find(b"\xff\xd9", 2)
                    if end == -1:
                        break
                    await publish_camera_frame(robot_id, bytes(buffer[:end + 2]))
                    del buffer[:end + 2]
                if len(buffer) > 10 * 1024 * 1024:
                    buffer.clear()

            if process.returncode is None:
                await process.wait()
        except asyncio.CancelledError:
            raise
        except FileNotFoundError:
            print("Camera error: FFmpeg was not found in the backend container.")
            await asyncio.sleep(5)
        except Exception as error:
            print(f"Camera decoder error for {robot_id}: {error}")
            await asyncio.sleep(3)
        finally:
            if process and process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=3)
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()
            if camera_processes.get(robot_id) is process:
                camera_processes.pop(robot_id, None)
        if robot_id in robots:
            await asyncio.sleep(1)


class CameraIngress(asyncio.DatagramProtocol):
    """Demultiplex shared-port RTP packets by the sender robot's IP address."""
    def __init__(self):
        self.transport = None
        self.unknown_sources = set()

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, packet, address):
        global camera_next_local_port
        source_ip = normalize_ip(address[0])
        matches = [
            rid for rid, robot in robots.items()
            if normalize_ip(robot.get("host")) == source_ip
        ]
        if len(matches) != 1:
            if source_ip and source_ip not in self.unknown_sources:
                self.unknown_sources.add(source_ip)
                print(f"Camera RTP ignored: source IP {source_ip} is not uniquely registered as a robot.")
            return

        robot_id = matches[0]
        camera_last_packet_at[robot_id] = time.time()
        camera_sender_ips[robot_id] = source_ip
        port = camera_local_ports.get(robot_id)
        if port is None:
            port = camera_next_local_port
            if port >= CAMERA_LOCAL_PORT_START + 10000:
                print("Camera RTP router has reached its local decoder-port limit.")
                return
            camera_next_local_port += 2
            camera_local_ports[robot_id] = port
            camera_worker_tasks[robot_id] = asyncio.create_task(camera_decoder(robot_id, port))
            # Forward the first packet too; the decoder starts listening immediately.

        self.transport.sendto(packet, ("127.0.0.1", port))


async def camera_receiver():
    """Receive all camera streams on the shared port and split them by source IP."""
    global camera_router_transport
    loop = asyncio.get_running_loop()
    while True:
        try:
            camera_router_transport, _ = await loop.create_datagram_endpoint(
                CameraIngress,
                local_addr=(CAMERA_HOST, CAMERA_PORT)
            )
            await asyncio.Future()
        except asyncio.CancelledError:
            raise
        except Exception as error:
            print(f"Camera RTP router error: {error}")
            await asyncio.sleep(3)
        finally:
            if camera_router_transport:
                camera_router_transport.close()
                camera_router_transport = None
            for task in tuple(camera_worker_tasks.values()):
                task.cancel()
            await asyncio.gather(*camera_worker_tasks.values(), return_exceptions=True)
            camera_worker_tasks.clear()
            camera_processes.clear()
            camera_local_ports.clear()


# ============================================================
# CAMERA STREAM ENDPOINT
# ============================================================

async def camera_stream_generator(robot_id):
    """
    Sends JPEG frames as an MJPEG multipart stream.
    """

    sequence = -1
    condition = camera_conditions.setdefault(robot_id, asyncio.Condition())

    while True:

        async with condition:

            try:

                await asyncio.wait_for(
                    condition.wait_for(
                        lambda: camera_sequences.get(robot_id, 0) != sequence
                    ),
                    timeout=15
                )

            except asyncio.TimeoutError:
                continue

            frame = camera_frames.get(robot_id)
            sequence = camera_sequences.get(robot_id, 0)

        if not frame:
            continue

        yield (
            b"--frame\r\n"
            b"Content-Type: image/jpeg\r\n"
            b"Content-Length: "
            + str(len(frame)).encode()
            + b"\r\n\r\n"
            + frame
            + b"\r\n"
        )


async def remove_robot_camera(robot_id):
    task = camera_worker_tasks.pop(robot_id, None)
    if task:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    camera_processes.pop(robot_id, None)
    camera_local_ports.pop(robot_id, None)
    camera_frames.pop(robot_id, None)
    camera_frame_at.pop(robot_id, None)
    camera_last_packet_at.pop(robot_id, None)
    camera_sender_ips.pop(robot_id, None)
    camera_sequences.pop(robot_id, None)
    camera_conditions.pop(robot_id, None)


# ============================================================
# ROBOT COMMUNICATION
# ============================================================

async def publish(robot, topic, typ, msg):
    """
    Publishes a ROS 2 message through rosbridge.
    """

    ws = robot.get("ws")

    if not ws or robot["status"] != "connected":

        raise HTTPException(
            status_code=409,
            detail="Robô desligado; comando bloqueado"
        )

    await ws.send(
        json.dumps({
            "op": "publish",
            "topic": topic,
            "msg": msg,
            "type": typ
        })
    )


async def stop(robot):
    """
    Sends a zero velocity command to the robot.
    """

    if robot.get("ws") and robot["status"] == "connected":

        try:

            await publish(
                robot,
                "/cmd_vel",
                "geometry_msgs/msg/Twist",
                {
                    "linear": {
                        "x": 0,
                        "y": 0,
                        "z": 0
                    },
                    "angular": {
                        "x": 0,
                        "y": 0,
                        "z": 0
                    }
                }
            )

        except Exception:
            pass


async def ros_reader(rid):
    """
    Connects to rosbridge and receives robot telemetry.
    """

    robot = robots[rid]

    url = f"ws://{robot['host']}:{robot['port']}"

    latency_task = None

    try:

        async with websockets.connect(
            url,
            open_timeout=5,
            ping_interval=10,
            ping_timeout=5,
            max_size=16 * 1024 * 1024
        ) as ws:

            robot["ws"] = ws
            robot["status"] = "connected"
            robot["connected_at"] = time.time()
            robot["latency_ms"] = None

            # Measure WebSocket latency

            async def measure_latency():

                while True:

                    try:

                        start = time.perf_counter()

                        pong = await ws.ping()

                        await asyncio.wait_for(
                            pong,
                            timeout=3
                        )

                        robot["latency_ms"] = round(
                            (time.perf_counter() - start) * 1000,
                            1
                        )

                    except Exception:

                        robot["latency_ms"] = None
                        break

                    await asyncio.sleep(1)

            latency_task = asyncio.create_task(
                measure_latency()
            )

            # Subscribe to all configured ROS topics

            for topic, typ in TOPICS.items():

                await ws.send(
                    json.dumps({
                        "op": "subscribe",
                        "topic": topic,
                        "type": typ,
                        "throttle_rate": 100,
                        "queue_length": 1
                    })
                )

            # Receive messages from rosbridge

            async for raw in ws:

                message = json.loads(raw)

                if (
                    message.get("op") == "publish"
                    and message.get("topic") in TOPICS
                ):

                    topic = message["topic"]

                    robot["data"][topic] = message.get("msg")
                    robot.setdefault("last_seen", {})[topic] = time.time()

                    robot["updated_at"] = (
                        datetime.now(timezone.utc).isoformat()
                    )

                    # Convert ROS topic names into frontend keys

                    telemetry_data = {
                        topic_name.lstrip("/").replace("/", "_"): value
                        for topic_name, value in robot["data"].items()
                    }

                    telemetry_data["updated_at"] = robot["updated_at"]

                    event = {
                        "type": "telemetry",
                        "robot_id": rid,
                        "data": telemetry_data
                    }

                    # Send telemetry to connected dashboard clients

                    for queue in tuple(listeners):

                        try:
                            queue.put_nowait(event)

                        except asyncio.QueueFull:
                            pass

    except asyncio.CancelledError:

        raise

    except Exception as error:

        robot["status"] = "error"
        robot["last_error"] = str(error)

    finally:

        if latency_task:

            latency_task.cancel()

            await asyncio.gather(
                latency_task,
                return_exceptions=True
            )

        await stop(robot)

        robot["ws"] = None
        robot["latency_ms"] = None

        if robot["status"] != "error":
            robot["status"] = "offline"

        async with lock:

            if lease["robot"] == rid:

                lease.update({
                    "user": None,
                    "robot": None,
                    "until": 0
                })

        persist()


# ============================================================
# WATCHDOG
# ============================================================

async def watchdog():
    """
    Releases control if the command lease expires.
    """

    while True:

        await asyncio.sleep(0.2)

        if (
            lease["robot"]
            and time.monotonic() > lease["until"]
        ):

            robot = robots.get(lease["robot"])

            lease.update({
                "user": None,
                "robot": None,
                "until": 0
            })

            if robot:
                await stop(robot)


# ============================================================
# APPLICATION LIFECYCLE
# ============================================================

@asynccontextmanager
async def lifespan(app: FastAPI):

    # Load saved robots

    if DB.exists():

        try:

            saved_robots = json.loads(
                DB.read_text(encoding="utf-8")
            )

            for item in saved_robots:

                robots[item["id"]] = {
                    **item,
                    "status": "offline",
                    "data": {},
                    "last_seen": {},
                    "task": None,
                    "ws": None,
                    "latency_ms": None
                }

        except Exception as error:

            print(f"Database loading error: {error}")

    # Start watchdog

    watchdog_task = asyncio.create_task(watchdog())

    # Start camera receiver

    camera_task = asyncio.create_task(camera_receiver())

    try:

        yield

    finally:

        watchdog_task.cancel()
        camera_task.cancel()

        await asyncio.gather(
            watchdog_task,
            camera_task,
            return_exceptions=True
        )

        for robot in robots.values():

            await stop(robot)

            if robot.get("task"):
                robot["task"].cancel()

        await asyncio.gather(
            *[
                robot["task"]
                for robot in robots.values()
                if robot.get("task")
            ],
            return_exceptions=True
        )


# ============================================================
# FASTAPI APPLICATION
# ============================================================

app = FastAPI(
    title="LIMO Fleet API",
    version="1.0.0",
    lifespan=lifespan
)


# ============================================================
# CORS
# ============================================================

app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv(
        "CORS_ORIGINS",
        "http://localhost:3000"
    ).split(","),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"]
)


# ============================================================
# HEALTH CHECK
# ============================================================

@app.get("/api/health")
async def health():

    return {
        "status": "ok"
    }


@app.get("/metrics", include_in_schema=False)
async def prometheus_metrics():

    refresh_metrics(robots)

    return Response(
        generate_latest(REGISTRY),
        media_type=CONTENT_TYPE_LATEST
    )


# ============================================================
# CAMERA STATUS
# ============================================================

@app.get("/api/camera/status")
async def camera_status(
    robot_id: str | None = None,
    user: str = Depends(user_dep)
):
    if robot_id:
        get_robot(robot_id)
        now = time.time()
        return {
            "available": now - camera_frame_at.get(robot_id, 0) <= 5,
            "receiving": now - camera_last_packet_at.get(robot_id, 0) <= 5,
            "expected_source_ip": normalize_ip(get_robot(robot_id).get("host")),
            "last_source_ip": camera_sender_ips.get(robot_id),
            "local_decoder_port": camera_local_ports.get(robot_id)
        }
    now = time.time()
    return {
        "available": any(now - seen <= 5 for seen in camera_frame_at.values()),
        "receiving": any(now - seen <= 5 for seen in camera_last_packet_at.values())
    }


# ============================================================
# CAMERA STREAM
# ============================================================

@app.get("/api/camera/stream")
async def camera_stream(
    token: str,
    robot_id: str | None = None
):

    # Authenticate the video stream

    claims(token)

    if not robot_id:
        if len(robots) != 1:
            raise HTTPException(
                status_code=400,
                detail="Indica o robot_id para escolher a câmara correta"
            )
        robot_id = next(iter(robots))

    get_robot(robot_id)

    return StreamingResponse(
        camera_stream_generator(robot_id),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "X-Accel-Buffering": "no"
        }
    )


# ============================================================
# LOGIN
# ============================================================

@app.post("/api/login")
async def login(data: Login):

    if not SECRET:

        raise HTTPException(
            status_code=503,
            detail="Define LIMO_SECRET_KEY antes de iniciar o servidor"
        )

    if not PASSWORD:

        raise HTTPException(
            status_code=503,
            detail="Define LIMO_ADMIN_PASSWORD antes de iniciar o servidor"
        )

    if (
        data.username != USER
        or data.password != PASSWORD
    ):

        raise HTTPException(
            status_code=401,
            detail="Credenciais inválidas"
        )

    return {
        "access_token": make_token(data.username),
        "token_type": "bearer"
    }


# ============================================================
# ROBOT HELPERS
# ============================================================

def public(robot):
    """
    Returns only public robot information.
    """

    return {
        key: robot[key]
        for key in (
            "id",
            "name",
            "host",
            "port",
            "status"
        )
    } | {
        "last_error": robot.get("last_error"),
        "latency_ms": robot.get("latency_ms")
    }


def get_robot(rid):

    if rid not in robots:

        raise HTTPException(
            status_code=404,
            detail="Robô não encontrado"
        )

    return robots[rid]


# ============================================================
# LIST ROBOTS
# ============================================================

@app.get("/api/robots")
async def list_robots(
    user: str = Depends(user_dep)
):

    return [
        public(robot)
        for robot in robots.values()
    ]


# ============================================================
# ADD ROBOT
# ============================================================

@app.post("/api/robots")
async def add_robot(
    data: RobotIn,
    user: str = Depends(user_dep)
):

    host = str(data.host)
    if any(normalize_ip(robot.get("host")) == normalize_ip(host) for robot in robots.values()):
        raise HTTPException(
            status_code=409,
            detail="Já existe um robô registado com esse IP. Cada robô precisa do seu próprio IP para separar a câmara."
        )

    rid = str(uuid.uuid4())

    robots[rid] = {
        "id": rid,
        "name": data.name,
        "host": host,
        "port": data.port,
        "status": "offline",
        "data": {},
        "task": None,
        "ws": None,
        "latency_ms": None
    }

    persist()

    return public(robots[rid])


# ============================================================
# DELETE ROBOT
# ============================================================

@app.delete("/api/robots/{rid}")
async def remove_robot(
    rid: str,
    user: str = Depends(user_dep)
):

    robot = get_robot(rid)

    await stop(robot)

    if robot.get("task"):

        robot["task"].cancel()

        await asyncio.gather(
            robot["task"],
            return_exceptions=True
        )

    await remove_robot_camera(rid)

    robots.pop(rid)

    persist()

    return {
        "ok": True
    }


# ============================================================
# CONNECT ROBOT
# ============================================================

@app.post("/api/robots/{rid}/connect")
async def connect(
    rid: str,
    user: str = Depends(user_dep)
):

    robot = get_robot(rid)

    if (
        robot.get("task")
        and not robot["task"].done()
    ):

        return public(robot)

    robot["status"] = "connecting"
    robot["last_error"] = None
    robot["data"] = {}
    robot["latency_ms"] = None

    robot["task"] = asyncio.create_task(
        ros_reader(rid)
    )

    return public(robot)


# ============================================================
# DISCONNECT ROBOT
# ============================================================

@app.post("/api/robots/{rid}/disconnect")
async def disconnect(
    rid: str,
    user: str = Depends(user_dep)
):

    robot = get_robot(rid)

    await stop(robot)

    if robot.get("task"):

        robot["task"].cancel()

        await asyncio.gather(
            robot["task"],
            return_exceptions=True
        )

        robot["task"] = None

    robot["status"] = "offline"
    robot["latency_ms"] = None

    async with lock:

        if lease["robot"] == rid:

            lease.update({
                "user": None,
                "robot": None,
                "until": 0
            })

    return public(robot)


# ============================================================
# ROBOT CONTROL
# ============================================================

@app.post("/api/robots/{rid}/control")
async def control(
    rid: str,
    data: Move,
    user: str = Depends(user_dep)
):

    robot = get_robot(rid)

    if robot["status"] != "connected":

        raise HTTPException(
            status_code=409,
            detail="Robô desligado; comando bloqueado"
        )

    async with lock:

        if (
            lease["until"] > time.monotonic()
            and (
                lease["user"] != user
                or lease["robot"] != rid
            )
        ):

            raise HTTPException(
                status_code=423,
                detail="Outro utilizador controla um robô. Aguarda a libertação do controlo."
            )

        lease.update({
            "user": user,
            "robot": rid,
            "until": time.monotonic() + 0.8
        })

    await publish(
        robot,
        "/cmd_vel",
        "geometry_msgs/msg/Twist",
        {
            "linear": {
                "x": data.linear,
                "y": 0,
                "z": 0
            },
            "angular": {
                "x": 0,
                "y": 0,
                "z": data.angular
            }
        }
    )

    CMD_VEL_COMMANDS.labels(robot_id=rid, robot_name=robot['name']).inc()
    if data.key:
        CONTROL_KEY_PRESSES.labels(robot_id=rid, robot_name=robot['name'], key=data.key).inc()

    return {
        "ok": True,
        "lease_ms": 800
    }


# ============================================================
# EMERGENCY STOP
# ============================================================

@app.post("/api/emergency-stop")
async def emergency(
    data: StopRequest,
    user: str = Depends(user_dep)
):

    if data.robot_id:

        targets = [
            get_robot(data.robot_id)
        ]

    else:

        targets = list(robots.values())

    async with lock:

        if (
            data.robot_id is None
            or lease["robot"] == data.robot_id
        ):

            lease.update({
                "user": None,
                "robot": None,
                "until": 0
            })

    for robot in targets:

        await stop(robot)

    return {
        "ok": True,
        "stopped": len(targets)
    }


# ============================================================
# DASHBOARD WEBSOCKET
# ============================================================

@app.websocket("/ws")
async def telemetry(ws: WebSocket):

    token = ws.query_params.get("token", "")

    try:

        claims(token)

    except HTTPException:

        await ws.close(code=4401)

        return

    await ws.accept()

    queue = asyncio.Queue(maxsize=16)

    listeners.add(queue)

    try:

        # Send initial robot list

        await ws.send_json({
            "type": "snapshot",
            "robots": [
                public(robot)
                for robot in robots.values()
            ]
        })

        # Send telemetry updates

        while True:

            event = await queue.get()

            await ws.send_json(event)

    except (
        WebSocketDisconnect,
        RuntimeError
    ):

        pass

    finally:

        listeners.discard(queue)
