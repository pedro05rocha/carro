import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PanelProps } from '@grafana/data';
import { locationService } from '@grafana/runtime';
import { SimpleOptions } from 'types';
import './LimoPanel.css';

type Robot = { id: string; name: string; host: string; port: number; status: 'offline'|'connecting'|'connected'|'error'; last_error?: string };
const TOKEN_KEY = 'limo_fleet_operator_token';
const API = `${window.location.protocol}//${window.location.hostname}:8000`;

async function request(path: string, token: string, options: RequestInit = {}) {
  const headers: Record<string,string> = { 'Content-Type':'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${API}${path}`, { ...options, headers: { ...headers, ...(options.headers as Record<string,string> || {}) } });
  if (!response.ok) {
    let message = response.statusText;
    try { message = (await response.json()).detail || message; } catch { /* retain HTTP status text */ }
    throw new Error(message);
  }
  return response.status === 204 ? null : response.json();
}

export const LimoPanel: React.FC<PanelProps<SimpleOptions>> = ({ width, height }) => {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || '');
  const [credentials, setCredentials] = useState({ username:'admin', password:'' });
  const [robots, setRobots] = useState<Robot[]>([]);
  const [selectedId, setSelectedId] = useState(() => localStorage.getItem('limo_selected_robot') || '');
  const [form, setForm] = useState({ name:'', host:'192.168.1.105', port:9090 });
  const [limits, setLimits] = useState({ linear:.3, angular:.8 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const timer = useRef<number | null>(null);
  const commandQueue = useRef<Promise<unknown>>(Promise.resolve());
  const lastDashboardRobot = useRef('');

  const refresh = useCallback(async () => {
    if (!token) return;
    const list = await request('/api/robots', token) as Robot[];
    setRobots(list);
    setSelectedId(current => {
      const currentRobot = list.find(robot => robot.id === current && robot.status === 'connected');
      const next = currentRobot?.id || list.find(robot => robot.status === 'connected')?.id || '';
      if (next) localStorage.setItem('limo_selected_robot', next);
      else localStorage.removeItem('limo_selected_robot');
      return next;
    });
  }, [token]);

  useEffect(() => {
    if (!token) return;
    refresh().catch(e => setError(e.message));
    const interval = window.setInterval(() => refresh().catch(e => setError(e.message)), 1500);
    return () => window.clearInterval(interval);
  }, [token, refresh]);

  useEffect(() => {
    const selected = robots.find(robot => robot.id === selectedId && robot.status === 'connected');
    const name = selected?.name || '.*';
    if (name === lastDashboardRobot.current) return;
    lastDashboardRobot.current = name;
    locationService.partial({ 'var-robot': name }, true);
  }, [selectedId, robots]);

  const enqueueMove = useCallback((robotId: string, linear: number, angular: number) => {
    commandQueue.current = commandQueue.current.then(() => request(`/api/robots/${robotId}/control`, token, {
      method:'POST', body:JSON.stringify({ linear, angular }),
    })).catch(e => { setError(e.message); });
  }, [token]);

  const stopHeld = useCallback((robotId = selectedId) => {
    if (timer.current !== null) window.clearInterval(timer.current);
    timer.current = null;
    if (robotId && token) enqueueMove(robotId, 0, 0);
  }, [enqueueMove, selectedId, token]);

  useEffect(() => () => {
    if (timer.current !== null) window.clearInterval(timer.current);
    if (selectedId && token) enqueueMove(selectedId, 0, 0);
  }, [selectedId, token, enqueueMove]);

  const hold = (linear: number, angular: number) => {
    if (!selectedId) return;
    if (timer.current !== null) window.clearInterval(timer.current);
    enqueueMove(selectedId, linear, angular);
    timer.current = window.setInterval(() => enqueueMove(selectedId, linear, angular), 300);
  };

  const choose = (id: string) => {
    setSelectedId(id);
    localStorage.setItem('limo_selected_robot', id);
  };

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await request('/api/login', '', { method:'POST', body:JSON.stringify(credentials) });
      localStorage.setItem(TOKEN_KEY, result.access_token);
      setToken(result.access_token);
      setError('');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try { await action(); await refresh(); setError(''); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const addAndConnect = async (event: React.FormEvent) => {
    event.preventDefault();
    await run(async () => {
      const robot = await request('/api/robots', token, { method:'POST', body:JSON.stringify(form) }) as Robot;
      await request(`/api/robots/${robot.id}/connect`, token, { method:'POST' });
      setForm(current => ({ ...current, name:'' }));
    });
  };

  const emergency = async () => run(async () => {
    await request('/api/emergency-stop', token, { method:'POST', body:JSON.stringify({ robot_id:selectedId }) });
  });

  if (!token) return <div className="limo-operator" style={{ width, height }}>
    <div className="limo-login-card"><div className="limo-kicker">LIMO FLEET · OPERAÇÕES</div><h2>Entrar na consola</h2>
      <p>Autentica-te para ligar robôs e enviar comandos.</p>
      <form onSubmit={login} className="limo-login-form">
        <input aria-label="Utilizador" value={credentials.username} onChange={e=>setCredentials({...credentials,username:e.target.value})} placeholder="Utilizador" autoComplete="username"/>
        <input aria-label="Palavra-passe" type="password" value={credentials.password} onChange={e=>setCredentials({...credentials,password:e.target.value})} placeholder="Palavra-passe" autoComplete="current-password"/>
        <button className="limo-primary" disabled={busy}>Entrar</button>
      </form>{error&&<div className="limo-error">{error}</div>}
    </div></div>;

  const selected = robots.find(robot => robot.id === selectedId && robot.status === 'connected');
  const connected = robots.filter(robot => robot.status === 'connected');
  return <div className="limo-operator" style={{ width, height }}>
    <div className="limo-topline"><div><div className="limo-kicker">LIMO FLEET · CONSOLA DE OPERAÇÕES</div><h2>Monitorização e controlo</h2></div>
      <div className="limo-top-actions"><div className={'limo-connection '+(connected.length?'is-online':'')}><i/>{connected.length?`${connected.length} ROBÔ(S) LIGADO(S)`:'SEM ROBÔS LIGADOS'}</div><button className="limo-logout" onClick={()=>{localStorage.removeItem(TOKEN_KEY);setToken('')}}>Terminar sessão</button></div>
    </div>
    {error&&<button className="limo-error-banner" onClick={()=>setError('')}>{error}<span>×</span></button>}
    <div className="limo-layout">
      <section className="limo-card limo-management"><div className="limo-card-head"><span>GESTÃO DE ROBÔS</span><span>{robots.length} TOTAL</span></div>
        <form className="limo-add-form" onSubmit={addAndConnect}>
          <input aria-label="Nome do robô" required placeholder="Nome (ex.: LIMO 1)" value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/>
          <div className="limo-form-row"><input aria-label="Endereço IP" required placeholder="Endereço IP" value={form.host} onChange={e=>setForm({...form,host:e.target.value})}/><input aria-label="Porta WebSocket" type="number" min="1" max="65535" value={form.port} onChange={e=>setForm({...form,port:Number(e.target.value)})}/></div>
          <button className="limo-secondary" disabled={busy}>＋ Adicionar e ligar</button>
        </form>
        <div className="limo-robot-list">{robots.length===0?<div className="limo-empty">Adiciona o primeiro robô pelo endereço IP.</div>:robots.map(robot=><div className={'limo-robot '+(selectedId===robot.id?'is-selected':'')} key={robot.id}>
          <button className="limo-robot-select" disabled={robot.status!=='connected'} onClick={()=>choose(robot.id)}><i className={'limo-dot '+robot.status}/><span><b>{robot.name}</b><small>{robot.host}:{robot.port} · {({connected:'Ligado',connecting:'A ligar…',error:'Erro',offline:'Desligado'} as Record<string,string>)[robot.status]}</small></span></button>
          {robot.status==='connected'?<button className="limo-mini-btn" disabled={busy} onClick={()=>run(()=>request(`/api/robots/${robot.id}/disconnect`,token,{method:'POST'}))}>Desligar</button>:<button className="limo-mini-btn" disabled={busy||robot.status==='connecting'} onClick={()=>run(()=>request(`/api/robots/${robot.id}/connect`,token,{method:'POST'}))}>{robot.status==='connecting'?'A ligar…':'Ligar'}</button>}
          <button className="limo-delete" title={'Remover '+robot.name} onClick={()=>run(()=>request(`/api/robots/${robot.id}`,token,{method:'DELETE'}))}>×</button>
          {robot.last_error&&<small className="limo-robot-error">{robot.last_error}</small>}
        </div>)}</div>
      </section>
      <section className="limo-card limo-driving"><div className="limo-card-head"><span>CONTROLO MANUAL</span><span className="limo-target">ALVO · {selected?.name||'NÃO SELECIONADO'}</span></div>
        {!selected&&<div className="limo-no-target">Seleciona um robô ligado na lista para ativar os comandos.</div>}
        <div className="limo-drive-body"><div className="limo-dpad">
          <button aria-label="Avançar" disabled={!selected} onPointerDown={e=>{e.currentTarget.setPointerCapture(e.pointerId);hold(limits.linear,0)}} onPointerUp={()=>stopHeld()} onPointerCancel={()=>stopHeld()}><span>↑</span></button>
          <button aria-label="Virar à esquerda" disabled={!selected} onPointerDown={e=>{e.currentTarget.setPointerCapture(e.pointerId);hold(0,limits.angular)}} onPointerUp={()=>stopHeld()} onPointerCancel={()=>stopHeld()}><span>←</span></button>
          <button className="limo-stop" aria-label="Parar" disabled={!selected} onClick={()=>stopHeld()}><span>■</span></button>
          <button aria-label="Virar à direita" disabled={!selected} onPointerDown={e=>{e.currentTarget.setPointerCapture(e.pointerId);hold(0,-limits.angular)}} onPointerUp={()=>stopHeld()} onPointerCancel={()=>stopHeld()}><span>→</span></button>
          <button aria-label="Recuar" disabled={!selected} onPointerDown={e=>{e.currentTarget.setPointerCapture(e.pointerId);hold(-limits.linear,0)}} onPointerUp={()=>stopHeld()} onPointerCancel={()=>stopHeld()}><span>↓</span></button>
        </div><div className="limo-limits"><label>Velocidade linear <b>{limits.linear.toFixed(2)} m/s</b></label><input type="range" min="0.05" max="0.6" step="0.05" value={limits.linear} onChange={e=>setLimits({...limits,linear:Number(e.target.value)})}/><label>Velocidade angular <b>{limits.angular.toFixed(1)} rad/s</b></label><input type="range" min="0.1" max="1.5" step="0.1" value={limits.angular} onChange={e=>setLimits({...limits,angular:Number(e.target.value)})}/>
          <button className="limo-emergency" disabled={!selected||busy} onClick={emergency}>⚠ PARAGEM DE EMERGÊNCIA</button>
        </div></div>
        <div className="limo-safety-note">Os comandos são enviados apenas ao robô selecionado. Ao largar um controlo, a consola envia velocidade zero.</div>
      </section>
      <section className="limo-card limo-telemetry"><div className="limo-card-head"><span>ROBÔ SELECIONADO</span><span>{selected?'ALVO DOS GRÁFICOS':'GRAFANA'}</span></div>
        <div className="limo-selected-name">{selected?.name||'—'}</div><div className="limo-selected-host">{selected?`${selected.host}:${selected.port}`:'Liga e seleciona um robô'}</div>
        <div className="limo-data-note">Seleciona um robô para filtrar os gráficos deste dashboard. A telemetria e o histórico aparecem nos painéis Grafana abaixo.</div>
        <div className="limo-camera-note">CÂMARA · SEM TÓPICO ROS CONFIRMADO</div>
      </section>
    </div>
  </div>;
};
