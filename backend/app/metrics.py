"""Prometheus metrics from the latest real ROS bridge telemetry."""
import math
from prometheus_client import CollectorRegistry, Gauge, Counter

REGISTRY = CollectorRegistry()
CONNECTED = Gauge('limo_robot_connected', 'Whether the ROS bridge is connected (1/0).', ['robot_id', 'robot_name'], registry=REGISTRY)
SENSOR_ONLINE = Gauge('limo_sensor_online', 'Whether a sensor topic has delivered data in the last 5 seconds (1/0).', ['robot_id', 'robot_name', 'topic'], registry=REGISTRY)
LINEAR_VELOCITY = Gauge('limo_linear_velocity_meters_per_second', 'Latest forward velocity from odometry.', ['robot_id', 'robot_name'], registry=REGISTRY)
ANGULAR_VELOCITY = Gauge('limo_angular_velocity_radians_per_second', 'Latest yaw velocity from odometry.', ['robot_id', 'robot_name'], registry=REGISTRY)
ACCELERATION_X = Gauge('limo_acceleration_x_meters_per_second_squared', 'Latest X acceleration from IMU.', ['robot_id', 'robot_name'], registry=REGISTRY)
BATTERY_VOLTAGE = Gauge('limo_battery_voltage_volts', 'Latest battery voltage from LimoStatus.', ['robot_id', 'robot_name'], registry=REGISTRY)
LIDAR_MIN = Gauge('limo_lidar_min_range_meters', 'Minimum finite positive range in the latest LaserScan.', ['robot_id', 'robot_name'], registry=REGISTRY)
CMD_VEL_COMMANDS = Counter('limo_cmd_vel_commands_total', 'Number of Twist commands sent by the dashboard.', ['robot_id', 'robot_name'], registry=REGISTRY)
EMERGENCY_STOPS = Counter('limo_emergency_stops_total', 'Number of dashboard emergency-stop requests.', ['robot_id', 'robot_name'], registry=REGISTRY)
SENSOR_TOPICS = ('/scan', '/imu', '/odom', '/limo_status')

def _labels(robot):
    return {'robot_id': robot['id'], 'robot_name': robot['name']}

def _put(gauge, labels, value):
    if value is None:
        try: gauge.remove(**labels)
        except KeyError: pass
    else:
        gauge.labels(**labels).set(value)

def refresh_metrics(robots):
    """Refresh live gauges before every scrape; Prometheus stores their history."""
    now = __import__('time').time()
    for robot in robots.values():
        labels = _labels(robot)
        connected = robot.get('status') == 'connected'
        CONNECTED.labels(**labels).set(1 if connected else 0)
        for topic in SENSOR_TOPICS:
            seen = robot.get('last_seen', {}).get(topic, 0)
            SENSOR_ONLINE.labels(**labels, topic=topic).set(1 if connected and now-seen <= 5 else 0)
        data = robot.get('data', {})
        odom = data.get('/odom', {})
        twist = odom.get('twist', {}).get('twist', {})
        linear = twist.get('linear', {}).get('x')
        angular = twist.get('angular', {}).get('z')
        imu = data.get('/imu', {})
        accel = imu.get('linear_acceleration', {}).get('x')
        status = data.get('/limo_status', {})
        battery = status.get('battery_voltage')
        scan = data.get('/scan', {}).get('ranges', [])
        if not connected:
            linear = angular = accel = battery = None
            scan = []
        _put(LINEAR_VELOCITY, labels, linear)
        _put(ANGULAR_VELOCITY, labels, angular)
        _put(ACCELERATION_X, labels, accel)
        _put(BATTERY_VOLTAGE, labels, battery)
        valid_ranges = [v for v in scan if isinstance(v, (int, float)) and math.isfinite(v) and v > 0]
        _put(LIDAR_MIN, labels, min(valid_ranges) if valid_ranges else None)

def remove_robot_metrics(robot):
    labels = _labels(robot)
    for gauge in (CONNECTED, LINEAR_VELOCITY, ANGULAR_VELOCITY, ACCELERATION_X, BATTERY_VOLTAGE, LIDAR_MIN):
        try: gauge.remove(**labels)
        except KeyError: pass
    for topic in SENSOR_TOPICS:
        try: SENSOR_ONLINE.remove(**labels, topic=topic)
        except KeyError: pass
    for counter in (CMD_VEL_COMMANDS, EMERGENCY_STOPS):
        try: counter.remove(**labels)
        except KeyError: pass
