import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PanelProps } from '@grafana/data';
import { SimpleOptions } from 'types';
import './LimoPanel.css';
import { PointCloudView } from './PointCloudView';

// ============================================================
// TIPOS
// ============================================================

type Robot = {
  id: string;
  name: string;
  host: string;
  port: number;
  status: 'offline' | 'connecting' | 'connected' | 'error';
  last_error?: string;
  latency_ms?: number | null;
};

type CameraStatus = {
  available: boolean;
  receiving: boolean;
  expected_source_ip?: string | null;
  last_source_ip?: string | null;
};

type Telemetry = {
  updated_at?: string;
  scan?: { ranges?: number[] };
  imu?: {
    linear_acceleration?: { x?: number };
    angular_velocity?: { z?: number };
  };
  odom?: {
    pose?: { pose?: { position?: { x?: number; y?: number } } };
    twist?: { twist?: { linear?: { x?: number }; angular?: { z?: number } } };
  };
  limo_status?: { battery_voltage?: number };
};

type CameraMode = 'video' | 'pointcloud';

// ============================================================
// CONSTANTES E UTILITÁRIOS
// ============================================================

const TOKEN_KEY = 'limo_fleet_operator_token';
const API = `${window.location.protocol}//${window.location.hostname}:8000`;
const WS = API.replace(/^http/, 'ws');

async function request(path: string, token: string, options: RequestInit = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: { ...headers, ...((options.headers as Record<string, string>) || {}) },
  });

  if (!response.ok) {
    let message = response.statusText;
    try {
      message = (await response.json()).detail || message;
    } catch {
      /* keep the HTTP status text */
    }
    throw new Error(message);
  }

  return response.status === 204 ? null : response.json();
}

const numberText = (value: unknown, digits = 2) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';

// ============================================================
// PAINEL SÓ COM CÂMARA (view === 'camera')
// ============================================================

const CameraOnlyPanel: React.FC<Pick<PanelProps<SimpleOptions>, 'width' | 'height'>> = ({ width, height }) => {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || '');
  const [robotId, setRobotId] = useState(() => localStorage.getItem('limo_selected_robot') || '');
  const [ready, setReady] = useState(false);
  const [cameraStatus, setCameraStatus] = useState<CameraStatus | null>(null);

  // Acompanha mudanças de sessão/robô feitas noutro painel
  useEffect(() => {
    const updateToken = () => setToken(localStorage.getItem(TOKEN_KEY) || '');
    const updateRobot = () => setRobotId(localStorage.getItem('limo_selected_robot') || '');

    window.addEventListener('storage', updateToken);
    window.addEventListener('storage', updateRobot);

    return () => {
      window.removeEventListener('storage', updateToken);
      window.removeEventListener('storage', updateRobot);
    };
  }, []);

  useEffect(() => setReady(false), [token, robotId]);

  // Estado da câmara, de 2 em 2 segundos
  useEffect(() => {
    if (!token || !robotId) {
      setCameraStatus(null);
      return;
    }

    let active = true;

    const update = () =>
      request(`/api/camera/status?robot_id=${encodeURIComponent(robotId)}`, token)
        .then(status => {
          if (active) {
            setCameraStatus(status as CameraStatus);
          }
        })
        .catch(() => {
          if (active) {
            setCameraStatus(null);
          }
        });

    update();
    const interval = window.setInterval(update, 2000);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [token, robotId]);

  const cameraHint = cameraStatus?.last_source_ip
    ? `Vídeo recebido de ${cameraStatus.last_source_ip}, mas ainda sem imagem descodificada.`
    : cameraStatus?.expected_source_ip
      ? `À espera de RTP em UDP 5004 vindo de ${cameraStatus.expected_source_ip}.`
      : 'À espera de vídeo RTP deste robô.';

  const headStatus = ready ? 'LIVE' : token && robotId ? 'À ESPERA DE VÍDEO' : 'SELECIONA UM ROBÔ';

  const placeholderText = !token
    ? 'Inicia sessão na consola PLATO para ver a câmara.'
    : !robotId
      ? 'Seleciona um robô na consola inicial.'
      : cameraHint;

  return (
    <div className="limo-mini-camera" style={{ width, height }}>
      <div className="limo-mini-camera-head">
        <span>
          <i className={ready ? 'is-online' : ''} /> CÂMARA FRONTAL{robotId ? ` · ${robotId}` : ''}
        </span>
        <b>{headStatus}</b>
      </div>

      <div className="limo-mini-camera-view">
        {token && robotId && (
          <img
            key={`${robotId}:${token}`}
            src={`${API}/api/camera/stream?robot_id=${encodeURIComponent(robotId)}&token=${encodeURIComponent(token)}`}
            alt={`Câmara frontal do ${robotId}`}
            onLoad={() => setReady(true)}
            onError={() => setReady(false)}
          />
        )}

        {!ready && (
          <div className="limo-mini-camera-placeholder">
            <strong>CAM_FWD_01</strong>
            <span>{placeholderText}</span>
          </div>
        )}
      </div>
    </div>
  );
};

// ============================================================
// CONSOLA DO OPERADOR
// ============================================================

const OperatorConsole: React.FC<PanelProps<SimpleOptions>> = ({ width, height }) => {
  // ----------------------------------------------------------
  // Estado
  // ----------------------------------------------------------
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || '');
  const [credentials, setCredentials] = useState({ username: 'admin', password: '' });
  const [robots, setRobots] = useState<Robot[]>([]);
  const [selectedId, setSelectedId] = useState(() => localStorage.getItem('limo_selected_robot') || '');
  const [telemetry, setTelemetry] = useState<Record<string, Telemetry>>({});
  const [limits, setLimits] = useState({ linear: 0.3, angular: 0.8 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [manageOpen, setManageOpen] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraStatus, setCameraStatus] = useState<CameraStatus | null>(null);
  const [cameraMode, setCameraMode] = useState<CameraMode>('video');
  const [switching, setSwitching] = useState(false);
  const [form, setForm] = useState({ name: '', host: '192.168.1.105', port: 9090 });

  const timer = useRef<number | null>(null);
  const keyboardTimer = useRef<number | null>(null);
  const pressedKeys = useRef(new Set<string>());
  const commandQueue = useRef<Promise<unknown>>(Promise.resolve());

  // ----------------------------------------------------------
  // Lista de robôs (atualiza de 1,5 em 1,5 s)
  // ----------------------------------------------------------
  const refresh = useCallback(async () => {
    if (!token) {
      return;
    }

    const list = (await request('/api/robots', token)) as Robot[];
    setRobots(list);

    setSelectedId(current => {
      const next =
        list.find(robot => robot.id === current && robot.status === 'connected')?.id ||
        list.find(robot => robot.status === 'connected')?.id ||
        '';

      if (next) {
        localStorage.setItem('limo_selected_robot', next);
      } else {
        localStorage.removeItem('limo_selected_robot');
      }

      return next;
    });
  }, [token]);

  useEffect(() => {
    if (!token) {
      return;
    }

    refresh().catch(e => setError(e.message));
    const interval = window.setInterval(() => refresh().catch(e => setError(e.message)), 1500);

    return () => window.clearInterval(interval);
  }, [token, refresh]);

  // ----------------------------------------------------------
  // Telemetria (WebSocket)
  // ----------------------------------------------------------
  useEffect(() => {
    if (!token) {
      return;
    }

    const socket = new WebSocket(`${WS}/ws?token=${encodeURIComponent(token)}`);

    socket.onmessage = event => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'telemetry') {
          setTelemetry(current => ({ ...current, [message.robot_id]: message.data }));
        }
      } catch {
        /* ignore malformed bridge messages */
      }
    };

    socket.onerror = () => setError('Ligação de telemetria interrompida.');

    return () => socket.close();
  }, [token]);

  // ----------------------------------------------------------
  // Valores derivados
  // ----------------------------------------------------------
  const connected = robots.filter(robot => robot.status === 'connected');
  const selected = robots.find(robot => robot.id === selectedId && robot.status === 'connected');
  const data = telemetry[selectedId] || {};
  const odom = data.odom;
  const imu = data.imu;
  const battery = data.limo_status?.battery_voltage;
  const linear = odom?.twist?.twist?.linear?.x;
  const acceleration = imu?.linear_acceleration?.x;
  const scanCount = data.scan?.ranges?.length || 0;
  const velocityKmh = typeof linear === 'number' ? Math.abs(linear) * 3.6 : null;
  const position = odom?.pose?.pose?.position;

  // ----------------------------------------------------------
  // Controlo do robô (botões e teclado)
  // ----------------------------------------------------------
  const enqueueMove = useCallback(
    (robotId: string, forward: number, turn: number, key?: string) => {
      commandQueue.current = commandQueue.current
        .then(() =>
          request(`/api/robots/${robotId}/control`, token, {
            method: 'POST',
            body: JSON.stringify({ linear: forward, angular: turn, ...(key ? { key } : {}) }),
          })
        )
        .catch(e => setError(e.message));
    },
    [token]
  );

  const stopHeld = useCallback(
    (robotId = selectedId) => {
      if (timer.current !== null) {
        window.clearInterval(timer.current);
      }
      timer.current = null;

      if (robotId && token) {
        enqueueMove(robotId, 0, 0);
      }
    },
    [enqueueMove, selectedId, token]
  );

  // (mantida da versão anterior; não é usada neste momento)
  const hold = (forward: number, turn: number) => {
    if (!selectedId) {
      return;
    }
    if (timer.current !== null) {
      window.clearInterval(timer.current);
    }
    enqueueMove(selectedId, forward, turn);
    timer.current = window.setInterval(() => enqueueMove(selectedId, forward, turn), 300);
  };
  void hold;

  const updateKeyboardMovement = useCallback(
    (pressedKey?: string) => {
      // As diagonais (q, e, z, c) são combinações de dois eixos
      const axes = new Set<string>();

      for (const key of pressedKeys.current) {
        if (key === 'q') {
          axes.add('w');
          axes.add('a');
        } else if (key === 'e') {
          axes.add('w');
          axes.add('d');
        } else if (key === 'z') {
          axes.add('s');
          axes.add('a');
        } else if (key === 'c') {
          axes.add('s');
          axes.add('d');
        } else {
          axes.add(key);
        }
      }

      const forward = (axes.has('w') ? limits.linear : 0) - (axes.has('s') ? limits.linear : 0);
      const turn = (axes.has('a') ? limits.angular : 0) - (axes.has('d') ? limits.angular : 0);

      if (selectedId && token) {
        enqueueMove(selectedId, forward, turn, pressedKey);
      }
    },
    [enqueueMove, limits.angular, limits.linear, selectedId, token]
  );

  useEffect(() => {
    if (!selected || !token) {
      pressedKeys.current.clear();
      return;
    }

    const valid = new Set(['w', 'a', 's', 'd', 'q', 'e', 'z', 'c', ' ']);

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest('input,textarea,select,[contenteditable="true"]')) {
        return;
      }

      const key = event.key.toLowerCase();
      if (!valid.has(key)) {
        return;
      }

      event.preventDefault();

      if (key === ' ') {
        pressedKeys.current.clear();
        stopHeld();
        return;
      }

      if (event.repeat || pressedKeys.current.has(key)) {
        return;
      }

      pressedKeys.current.add(key);
      updateKeyboardMovement(key);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (pressedKeys.current.delete(event.key.toLowerCase())) {
        updateKeyboardMovement();
      }
    };

    const release = () => {
      if (pressedKeys.current.size) {
        pressedKeys.current.clear();
        stopHeld();
      }
    };

    // Renova o comando enquanto houver teclas premidas (o robô tem um lease de 0,8 s)
    keyboardTimer.current = window.setInterval(() => {
      if (pressedKeys.current.size) {
        updateKeyboardMovement();
      }
    }, 300);

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', release);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', release);

      if (keyboardTimer.current !== null) {
        window.clearInterval(keyboardTimer.current);
      }
      keyboardTimer.current = null;

      release();
    };
  }, [selected?.id, stopHeld, token, updateKeyboardMovement]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ao sair/mudar de robô, pára o movimento
  useEffect(
    () => () => {
      if (timer.current !== null) {
        window.clearInterval(timer.current);
      }
      if (selectedId && token) {
        enqueueMove(selectedId, 0, 0);
      }
    },
    [selectedId, token, enqueueMove]
  );

  // ----------------------------------------------------------
  // Estado da câmara
  // ----------------------------------------------------------
  useEffect(() => setCameraReady(false), [selectedId]);

  useEffect(() => {
    if (!token || !selectedId) {
      setCameraStatus(null);
      return;
    }

    let active = true;

    const update = () =>
      request(`/api/camera/status?robot_id=${encodeURIComponent(selectedId)}`, token)
        .then(status => {
          if (active) {
            setCameraStatus(status as CameraStatus);
          }
        })
        .catch(() => {
          if (active) {
            setCameraStatus(null);
          }
        });

    update();
    const interval = window.setInterval(update, 2000);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [token, selectedId]);

  const cameraStatusText = cameraStatus?.last_source_ip
    ? `RTP recebido de ${cameraStatus.last_source_ip}; imagem ainda não descodificada.`
    : cameraStatus?.expected_source_ip
      ? `Sem RTP de ${cameraStatus.expected_source_ip} em UDP 5004.`
      : 'A aguardar vídeo RTP deste robô.';

  // ----------------------------------------------------------
  // Ações
  // ----------------------------------------------------------
  const choose = (id: string) => {
    setSelectedId(id);
    localStorage.setItem('limo_selected_robot', id);
  };

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);

    try {
      const result = await request('/api/login', '', {
        method: 'POST',
        body: JSON.stringify(credentials),
      });
      localStorage.setItem(TOKEN_KEY, result.access_token);
      setToken(result.access_token);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);

    try {
      await action();
      await refresh();
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const connect = async (id: string) => run(() => request(`/api/robots/${id}/connect`, token, { method: 'POST' }));

  const disconnect = async (id: string) => run(() => request(`/api/robots/${id}/disconnect`, token, { method: 'POST' }));

  const emergency = async () =>
    run(() =>
      request('/api/emergency-stop', token, {
        method: 'POST',
        body: JSON.stringify({ robot_id: selectedId }),
      })
    );

  const switchCamera = (mode: CameraMode) =>
    run(async () => {
      setSwitching(true);

      try {
        await request(`/api/robots/${selectedId}/camera-mode`, token, {
          method: 'POST',
          body: JSON.stringify({ mode }),
        });

        setCameraMode(mode);
        setCameraReady(false);
      } finally {
        setSwitching(false);
      }
    });

  const addAndConnect = async (event: React.FormEvent) => {
    event.preventDefault();

    await run(async () => {
      const robot = (await request('/api/robots', token, {
        method: 'POST',
        body: JSON.stringify(form),
      })) as Robot;

      await request(`/api/robots/${robot.id}/connect`, token, { method: 'POST' });
      setForm(current => ({ ...current, name: '' }));
    });
  };

  const moreDetails = () => {
    const robotVar = selected?.name ? `&var-robot=${encodeURIComponent(selected.name)}` : '';
    window.location.assign(`/d/limo-details/limo-fleet-mais-detalhes?orgId=1&refresh=5s${robotVar}`);
  };

  // ----------------------------------------------------------
  // Ecrã de login
  // ----------------------------------------------------------
  if (!token) {
    return (
      <div className="limo-console-login" style={{ width, height }}>
        <form onSubmit={login} className="limo-console-login-card">
          <div className="console-kicker">PLATO · AUTONOMOUS OPERATIONS</div>
          <h2>Iniciar sessão</h2>

          <label>
            Utilizador
            <input
              aria-label="Utilizador"
              value={credentials.username}
              onChange={e => setCredentials({ ...credentials, username: e.target.value })}
              autoComplete="username"
            />
          </label>

          <label>
            Palavra-passe
            <input
              aria-label="Palavra-passe"
              type="password"
              value={credentials.password}
              onChange={e => setCredentials({ ...credentials, password: e.target.value })}
              autoComplete="current-password"
            />
          </label>

          <button className="console-primary" disabled={busy}>
            Entrar
          </button>

          {error && <div className="console-error">{error}</div>}
        </form>
      </div>
    );
  }

  // ----------------------------------------------------------
  // Blocos auxiliares de apresentação
  // ----------------------------------------------------------
  const sensorRows: Array<[string, string, boolean]> = [
    ['LiDAR', '/scan', !!data.scan],
    ['IMU', '/imu', !!imu],
    ['Odometry', '/odom', !!odom],
    ['LIMO Status', '/limo_status', !!data.limo_status],
    ['Câmara frontal', 'RTP · UDP 5004', cameraReady],
  ];

  const panel = (title: string, sub: string, content: React.ReactNode, cls = '') => (
    <section className={`console-panel ${cls}`} key={title}>
      <div className="console-panel-head">
        <span>
          <small>{sub}</small>
          {title}
        </span>
        <i />
      </div>
      {content}
    </section>
  );

  const metric = (value: string, unit: string, foot: string) => (
    <div className="console-metric">
      <b>{value}</b>
      <span>{unit}</span>
      <small>{foot}</small>
    </div>
  );

  const manualButton = (
    className: string,
    label: string,
    glyph: string,
    forward: number,
    turn: number,
    key: string
  ) => (
    <button
      className={className}
      aria-label={label}
      title={label}
      disabled={!selected}
      onPointerDown={event => {
        event.currentTarget.setPointerCapture(event.pointerId);

        if (selectedId) {
          enqueueMove(selectedId, forward, turn, key);

          if (timer.current !== null) {
            window.clearInterval(timer.current);
          }
          timer.current = window.setInterval(() => enqueueMove(selectedId, forward, turn), 300);
        }
      }}
      onPointerUp={() => stopHeld()}
      onPointerCancel={() => stopHeld()}
    >
      <span>{glyph}</span>
    </button>
  );

  // ----------------------------------------------------------
  // Cabeçalho
  // ----------------------------------------------------------
  const header = (
    <header className="console-header">
      <div className="console-brand">
        <div className="console-mark">P</div>
        <div>
          <b>PLATO</b>
          <small>AUTONOMOUS OPERATIONS</small>
        </div>
      </div>

      <div className="console-system">
        <i className={connected.length ? 'is-online' : ''} />
        {connected.length ? 'SYSTEM NOMINAL' : 'AWAITING ROBOT CONNECTION'}
      </div>

      <label className="console-vehicle">
        <span>VEÍCULO</span>
        <select aria-label="Veículo" value={selectedId} onChange={e => choose(e.target.value)}>
          <option value="">Escolher veículo…</option>
          {connected.map(robot => (
            <option key={robot.id} value={robot.id}>
              {robot.name}
            </option>
          ))}
        </select>
        <b className="console-vehicle-current">{selected?.name || 'Nenhum selecionado'}</b>
      </label>

      <div className="console-mission">
        <small>SESSÃO</small>
        <b>{selected ? 'CONTROLO ATIVO' : 'SEM ROBÔ SELECIONADO'}</b>
      </div>

      <div className="console-actions">
        <span className="console-clock">{new Date().toLocaleTimeString('pt-PT')}</span>

        <button className="console-details-button" onClick={moreDetails}>
          <span>▤</span>
          <span>
            Mais detalhes<small>Câmara e gráficos</small>
          </span>
          <b>↗</b>
        </button>

        <button className="console-secondary" onClick={() => setManageOpen(true)}>
          Gestão de robôs
        </button>

        <button
          className="console-logout"
          onClick={() => {
            localStorage.removeItem(TOKEN_KEY);
            setToken('');
          }}
        >
          Sair
        </button>
      </div>
    </header>
  );

  // ----------------------------------------------------------
  // Coluna esquerda
  // ----------------------------------------------------------
  const leftRail = (
    <aside className="console-rail console-left">
      {panel(
        'VELOCITY',
        'DRIVE',
        <>
          {metric(
            velocityKmh === null ? '—' : velocityKmh.toFixed(0),
            'KM/H',
            linear == null ? 'A aguardar odometria' : `Linear ${numberText(linear)} m/s`
          )}
          <div className="console-meter">
            <i style={{ width: `${velocityKmh === null ? 0 : Math.min(100, velocityKmh / 1.6)}%` }} />
          </div>
          <div className="console-footline">
            CRUISE {linear == null ? 'INACTIVE' : 'ACTIVE'}
            <b>{linear == null ? '' : `${velocityKmh?.toFixed(0)} KM/H`}</b>
          </div>
        </>,
        'console-speed'
      )}

      {panel(
        'ACCELERATION',
        'MOTION',
        <>
          {metric(
            acceleration == null ? '—' : `${acceleration >= 0 ? '+' : ''}${numberText(acceleration)}`,
            'M/S²',
            'Linear acceleration'
          )}
          <div className="console-split">
            <span>
              LATERAL<b>—</b>
            </span>
            <span>
              YAW RATE<b>{numberText(imu?.angular_velocity?.z, 1)} °/S</b>
            </span>
          </div>
        </>,
        'console-accel'
      )}

      {panel(
        'DISTANCE / ODOMETER',
        'VEHICLE',
        <>
          <div className="console-split">
            <span>
              POSITION X<b>{position ? `${numberText(position.x)} M` : '—'}</b>
            </span>
            <span>
              POSITION Y<b>{position ? `${numberText(position.y)} M` : '—'}</b>
            </span>
          </div>
          <div className="console-split">
            <span>
              ORIENTATION<b>{odom?.pose ? 'AVAILABLE' : '—'}</b>
            </span>
            <span>
              ODOMETRY<b>{odom ? 'ONLINE' : '—'}</b>
            </span>
          </div>
        </>,
        'console-odom'
      )}

      {panel(
        'LIDAR / DISTANCES',
        'PERCEPTION',
        <div className="console-lidar">
          <div className="console-radar">
            <i />
            <b>⌖</b>
          </div>
          <div>
            <strong>{scanCount || '—'}</strong>
            <small>{scanCount ? 'SCAN POINTS' : 'NO DATA'}</small>
            <small>/scan · LaserScan</small>
          </div>
        </div>,
        'console-lidar-panel'
      )}
    </aside>
  );

  // ----------------------------------------------------------
  // Centro: câmara (vídeo ou point cloud)
  // ----------------------------------------------------------
  const showPlaceholder = !selected || (cameraMode === 'video' && (switching || !cameraReady));

  const stage = (
    <main className="console-stage">
      <div className="console-camera-head">
        <span>
          <i className={cameraReady ? 'is-online' : ''} />
          {selected ? `LIVE · CAM_FWD_01 · ${selected.name}` : 'LIVE · CAM_FWD_01'}
        </span>

        <b className={selected ? 'active' : ''}>{selected ? 'TESTE_PEDRO_999999' : 'AWAITING CONNECTION'}</b>

        <button
          className="console-secondary"
          disabled={!selected || switching || busy}
          onClick={() => switchCamera(cameraMode === 'video' ? 'pointcloud' : 'video')}
        >
          {switching ? 'A trocar…' : cameraMode === 'video' ? 'Ver point cloud' : 'Ver vídeo'}
        </button>
      </div>

      <div className="console-camera">
        {/* Vídeo: só monta depois de a troca acabar, para não mostrar um frame antigo */}
        {selected && cameraMode === 'video' && !switching && (
          <img
            key={selected.id}
            src={`${API}/api/camera/stream?robot_id=${encodeURIComponent(selected.id)}&token=${encodeURIComponent(token)}`}
            alt={`Câmara frontal do ${selected.name}`}
            onLoad={() => setCameraReady(true)}
            onError={() => setCameraReady(false)}
          />
        )}

        {/* Point cloud */}
        {selected && cameraMode === 'pointcloud' && (
          <PointCloudView key={selected.id} token={token} robotId={selected.id} />
        )}

        {/* Mensagem de espera */}
        {showPlaceholder && (
          <div className="console-camera-placeholder">
            <div className="console-camera-grid" />
            <div>
              <span>CAM_FWD_01</span>
              <b>
                {!selected ? 'Liga um robô para começar' : switching ? 'A trocar de modo…' : 'A aguardar vídeo do veículo'}
              </b>
              <small>
                {!selected
                  ? 'Liga o LIMO para ver a câmara frontal.'
                  : switching
                    ? 'A mudar de vista…'
                    : cameraStatusText}
              </small>
            </div>
          </div>
        )}

        {position && (
          <div className="console-coordinates">
            X {numberText(position.x)} · Y {numberText(position.y)} M
          </div>
        )}

        <div className="console-camera-time">
          {data.updated_at ? `TELEMETRY ${new Date(data.updated_at).toLocaleTimeString('pt-PT')}` : 'AWAITING TELEMETRY'}
        </div>
      </div>

      <div className="console-stage-footer">
        <span>
          <i className={selected ? 'is-online' : ''} />
          {selected ? `${selected.name} · ${selected.host}` : 'Nenhum robô selecionado'}
        </span>
        <span>{selected ? 'COMUNICAÇÃO ATIVA' : 'SEM COMUNICAÇÃO'}</span>
      </div>
    </main>
  );

  // ----------------------------------------------------------
  // Coluna direita
  // ----------------------------------------------------------
  const rightRail = (
    <aside className="console-rail console-right">
      {panel(
        'BATTERY / VOLTAGE',
        'POWERTRAIN',
        <>
          {metric(
            battery == null ? '—' : numberText(battery, 1),
            'V',
            battery == null ? 'Battery unavailable' : 'LIMO status'
          )}
          <div className="console-split">
            <span>
              VOLTAGE<b>{battery == null ? '—' : `${numberText(battery, 1)} V`}</b>
            </span>
            <span>
              CORE TEMP<b>—</b>
            </span>
          </div>
        </>,
        'console-battery'
      )}

      {panel(
        'NETWORK LATENCY',
        'CONNECTIVITY',
        <>
          {metric(
            selected?.latency_ms == null ? '—' : numberText(selected.latency_ms, 0),
            'MS',
            selected?.latency_ms == null ? 'Awaiting ROS bridge' : 'ROS bridge round trip'
          )}
          <div className="console-latency-line">
            {selected?.latency_ms != null ? '●  ROSBRIDGE ONLINE' : '○  NO CONNECTION'}
          </div>
        </>,
        'console-network'
      )}

      {panel(
        'STATE OF PLATOON',
        'V2X NETWORK',
        <>
          <div className="console-fleet-head">
            <span>ID</span>
            <span>STATE</span>
            <span>KM/H</span>
          </div>

          {robots.length ? (
            robots.map(robot => (
              <button
                className={`console-fleet-row ${robot.id === selectedId ? 'chosen' : ''}`}
                key={robot.id}
                onClick={() => robot.status === 'connected' && choose(robot.id)}
              >
                <span>
                  <i className={robot.status === 'connected' ? 'is-online' : ''} />
                  {robot.name}
                </span>
                <span>
                  {robot.status === 'connected'
                    ? robot.id === selectedId
                      ? 'HOST'
                      : 'FOLLOW'
                    : robot.status.toUpperCase()}
                </span>
                <b>{numberText((telemetry[robot.id]?.odom?.twist?.twist?.linear?.x || 0) * 3.6, 0)}</b>
              </button>
            ))
          ) : (
            <p className="console-empty">Adiciona um robô em Gestão de robôs.</p>
          )}

          <div className="console-footline">
            FORMATION{' '}
            <b>
              {connected.length} UNIT{connected.length === 1 ? '' : 'S'}
            </b>
          </div>
        </>,
        'console-fleet'
      )}

      {panel(
        'REAR VISION / SENSORS',
        'PERCEPTION',
        <div className="console-sensors">
          {sensorRows.map(([name, topic, ok]) => (
            <div className="console-sensor" key={name}>
              <i className={ok ? 'is-online' : ''} />
              <span>
                {name}
                <small>{topic}</small>
              </span>
              <b className={ok ? 'is-online' : ''}>{ok ? 'OK' : 'NO DATA'}</b>
            </div>
          ))}
        </div>,
        'console-sensor-panel'
      )}

      {panel(
        'MANUAL CONTROL',
        'CMD_VEL',
        <>
          <div className="console-target">
            TARGET · <b>{selected?.name || 'NO ROBOT'}</b>
          </div>

          <div className="console-drive-grid">
            {manualButton('diag-ul', 'Diagonal à frente e esquerda (Q)', '↖', limits.linear, limits.angular, 'q')}
            {manualButton('drive-up', 'Avançar (W)', '↑', limits.linear, 0, 'w')}
            {manualButton('diag-ur', 'Diagonal à frente e direita (E)', '↗', limits.linear, -limits.angular, 'e')}

            {manualButton('drive-left', 'Virar à esquerda (A)', '←', 0, limits.angular, 'a')}
            <button className="drive-stop" aria-label="Parar (espaço)" disabled={!selected} onClick={() => stopHeld()}>
              <span>■</span>
            </button>
            {manualButton('drive-right', 'Virar à direita (D)', '→', 0, -limits.angular, 'd')}

            {manualButton('diag-dl', 'Diagonal atrás e esquerda (Z)', '↙', -limits.linear, limits.angular, 'z')}
            {manualButton('drive-down', 'Recuar (S)', '↓', -limits.linear, 0, 's')}
            {manualButton('diag-dr', 'Diagonal atrás e direita (C)', '↘', -limits.linear, -limits.angular, 'c')}
          </div>

          <div className="console-key-help">WASD mover · Q/E/Z/C diagonais · Espaço parar</div>

          <div className="console-range">
            <label>
              LINEAR <b>{limits.linear.toFixed(2)} M/S</b>
            </label>
            <input
              type="range"
              min=".05"
              max=".6"
              step=".05"
              value={limits.linear}
              onChange={e => setLimits({ ...limits, linear: Number(e.target.value) })}
            />

            <label>
              ANGULAR <b>{limits.angular.toFixed(1)} RAD/S</b>
            </label>
            <input
              type="range"
              min=".1"
              max="1.5"
              step=".1"
              value={limits.angular}
              onChange={e => setLimits({ ...limits, angular: Number(e.target.value) })}
            />
          </div>

          <button className="console-emergency" disabled={!selected || busy} onClick={emergency}>
            ⚠ PARAGEM DE EMERGÊNCIA
          </button>
        </>,
        'console-control'
      )}
    </aside>
  );

  // ----------------------------------------------------------
  // Barra de estado
  // ----------------------------------------------------------
  const statusBar = (
    <footer className="console-statusbar">
      <span>
        <i className={scanCount ? 'is-online' : ''} /> PERCEPTION
      </span>
      <span>
        <i className={odom ? 'is-online' : ''} /> LOCALIZATION
      </span>
      <span>
        <i className={selected ? 'is-online' : ''} /> CONTROL
      </span>
      <b>{selected ? 'ALL SYSTEMS OPERATIONAL' : error || 'ADICIONA E LIGA UM ROBÔ PARA COMEÇAR'}</b>
      <span>IMU {imu ? 'ONLINE' : '—'}</span>
      <span>LiDAR {scanCount ? 'ONLINE' : '—'}</span>
    </footer>
  );

  // ----------------------------------------------------------
  // Janela de gestão de robôs
  // ----------------------------------------------------------
  const manageModal = manageOpen && (
    <div
      className="console-modal-backdrop"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget) {
          setManageOpen(false);
        }
      }}
    >
      <section className="console-modal" role="dialog" aria-modal="true" aria-label="Gestão de robôs">
        <div className="console-modal-head">
          <div>
            <small>PLATO · ROBOT MANAGEMENT</small>
            <h2>Gestão de robôs</h2>
          </div>
          <button aria-label="Fechar" onClick={() => setManageOpen(false)}>
            ×
          </button>
        </div>

        <form className="console-robot-form" onSubmit={addAndConnect}>
          <label>
            Nome
            <input
              required
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              placeholder="LIMO 1"
            />
          </label>

          <div>
            <label>
              Endereço IP
              <input required value={form.host} onChange={e => setForm({ ...form, host: e.target.value })} />
            </label>
            <label>
              Porta
              <input
                type="number"
                min="1"
                max="65535"
                value={form.port}
                onChange={e => setForm({ ...form, port: Number(e.target.value) })}
              />
            </label>
          </div>

          <button className="console-primary" disabled={busy}>
            ＋ Adicionar e ligar
          </button>
        </form>

        <div className="console-robot-list">
          {robots.map(robot => (
            <div className="console-robot-item" key={robot.id}>
              <span>
                <i className={robot.status === 'connected' ? 'is-online' : ''} />
                <b>{robot.name}</b>
                <small>
                  {robot.host}:{robot.port} · {robot.status}
                </small>
              </span>

              {robot.status === 'connected' ? (
                <button onClick={() => disconnect(robot.id)} disabled={busy}>
                  Desligar
                </button>
              ) : (
                <button onClick={() => connect(robot.id)} disabled={busy || robot.status === 'connecting'}>
                  Ligar
                </button>
              )}

              <button
                className="remove-robot"
                aria-label={`Remover ${robot.name}`}
                disabled={busy}
                onClick={() => run(() => request(`/api/robots/${robot.id}`, token, { method: 'DELETE' }))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );

  // ----------------------------------------------------------
  // Render final
  // ----------------------------------------------------------
  return (
    <div className="limo-console" style={{ width, height }}>
      {header}

      {error && (
        <button className="console-toast" onClick={() => setError('')}>
          {error}
          <span>×</span>
        </button>
      )}

      <div className="console-grid">
        {leftRail}
        {stage}
        {rightRail}
      </div>

      {statusBar}
      {manageModal}
    </div>
  );
};

// ============================================================
// PONTO DE ENTRADA DO PLUGIN
// ============================================================

export const LimoPanel: React.FC<PanelProps<SimpleOptions>> = props =>
  props.options.view === 'camera' ? (
    <CameraOnlyPanel width={props.width} height={props.height} />
  ) : (
    <OperatorConsole {...props} />
  );
