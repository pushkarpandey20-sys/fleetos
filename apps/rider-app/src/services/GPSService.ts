// apps/rider-app/src/services/GPSService.ts
// Background GPS tracking — foreground service on Android, significant location on iOS
import BackgroundGeolocation, {
  Location,
  State,
} from 'react-native-background-geolocation';
import { Platform } from 'react-native';
import { store } from '../store';
import { webSocketService } from './WebSocketService';
import { offlineQueue } from './OfflineQueueService';

const GPS_CONFIG = {
  // Android foreground service config
  notification: {
    title: 'FleetOS Rider',
    text: 'Tracking active — tap to open app',
    smallIcon: 'mipmap/ic_launcher',
    priority: BackgroundGeolocation.NOTIFICATION_PRIORITY_LOW,
  },

  // Location config
  desiredAccuracy: BackgroundGeolocation.DESIRED_ACCURACY_HIGH,
  distanceFilter: 10,            // min 10m movement to trigger update
  stationaryRadius: 25,          // considered stationary within 25m

  // Intervals
  locationUpdateInterval: 5000,          // 5s when moving
  fastestLocationUpdateInterval: 5000,
  heartbeatInterval: 30,                 // 30s heartbeat when stationary

  // Power saving
  pausesLocationUpdatesAutomatically: false,
  stopOnTerminate: false,       // keep running after app termination
  startOnBoot: true,            // restart on device reboot

  // iOS specific
  activityType: BackgroundGeolocation.ACTIVITY_TYPE_AUTOMOTIVE_NAVIGATION,
  showsBackgroundLocationIndicator: true,

  debug: __DEV__,
  logLevel: __DEV__
    ? BackgroundGeolocation.LOG_LEVEL_VERBOSE
    : BackgroundGeolocation.LOG_LEVEL_ERROR,
};

class GPSService {
  private isTracking = false;
  private lastLat = 0;
  private lastLng = 0;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;

  async initialize() {
    await BackgroundGeolocation.ready(GPS_CONFIG);

    BackgroundGeolocation.onLocation(this.handleLocation.bind(this));
    BackgroundGeolocation.onMotionChange(this.handleMotionChange.bind(this));
    BackgroundGeolocation.onConnectivityChange(this.handleConnectivityChange.bind(this));
    BackgroundGeolocation.onHeartbeat(this.handleHeartbeat.bind(this));

    console.log('[GPS] Service initialized');
  }

  async start() {
    if (this.isTracking) return;
    const state: State = await BackgroundGeolocation.start();
    this.isTracking = state.enabled;
    console.log('[GPS] Tracking started:', state.enabled);
  }

  async stop() {
    await BackgroundGeolocation.stop();
    this.isTracking = false;
    console.log('[GPS] Tracking stopped');
  }

  private async handleLocation(location: Location) {
    const { coords, battery } = location;
    const { latitude: lat, longitude: lng, accuracy, speed, heading } = coords;

    this.lastLat = lat;
    this.lastLng = lng;

    // Adaptive interval: extend when battery < 20%
    const batteryPct = Math.round(battery.level * 100);
    if (batteryPct < 20) {
      await BackgroundGeolocation.setConfig({ locationUpdateInterval: 15000 });
    } else {
      await BackgroundGeolocation.setConfig({ locationUpdateInterval: 5000 });
    }

    const payload = {
      type: 'location',
      lat,
      lng,
      accuracy_m: Math.round(accuracy),
      speed_kmh: speed ? Math.round(speed * 3.6) : 0,
      heading_deg: heading ? Math.round(heading) : 0,
      battery_pct: batteryPct,
    };

    if (webSocketService.isConnected()) {
      webSocketService.send(payload);
    } else {
      // Queue for sync when reconnected
      await offlineQueue.enqueue({ type: 'location', data: payload, ts: Date.now() });
    }
  }

  private handleMotionChange(event: any) {
    console.log('[GPS] Motion change:', event.isMoving);
    // Plugin automatically adjusts update frequency based on motion state
  }

  private handleConnectivityChange(event: any) {
    console.log('[GPS] Connectivity:', event.connected);
    if (event.connected) {
      // Drain offline queue
      offlineQueue.drainToWebSocket(webSocketService);
    }
  }

  private async handleHeartbeat(event: any) {
    // Send last known position on heartbeat (when stationary)
    if (this.lastLat !== 0) {
      const batteryPct = Math.round(event.battery.level * 100);
      webSocketService.send({
        type: 'location',
        lat: this.lastLat,
        lng: this.lastLng,
        accuracy_m: 50,
        speed_kmh: 0,
        heading_deg: 0,
        battery_pct: batteryPct,
      });
    }
  }

  getCurrentPosition(): Promise<{ lat: number; lng: number }> {
    return new Promise((resolve, reject) => {
      BackgroundGeolocation.getCurrentPosition({
        timeout: 15,
        maximumAge: 5000,
        desiredAccuracy: 10,
        samples: 3,
      })
      .then((loc: Location) => resolve({ lat: loc.coords.latitude, lng: loc.coords.longitude }))
      .catch(reject);
    });
  }
}

export const gpsService = new GPSService();

// ─── WebSocket Service ────────────────────────────────────────────────
// apps/rider-app/src/services/WebSocketService.ts
class WebSocketService {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private token = '';

  connect(token: string) {
    this.token = token;
    this._connect();
  }

  private _connect() {
    const url = `${process.env.WS_URL}?token=${this.token}`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log('[WS] Connected');
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.pingTimer = setInterval(() => this.send({ type: 'ping' }), 20_000);
      offlineQueue.drainToWebSocket(this);
    };

    this.ws.onclose = () => {
      console.log('[WS] Disconnected, reconnecting in 5s...');
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.reconnectTimer = setTimeout(() => this._connect(), 5000);
    };

    this.ws.onmessage = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'new_task') {
          store.dispatch({ type: 'tasks/taskAdded', payload: msg.task });
        }
      } catch {}
    };

    this.ws.onerror = (e: Event) => console.error('[WS] Error:', e);
  }

  send(payload: object) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

export const webSocketService = new WebSocketService();

// ─── Offline Queue ─────────────────────────────────────────────────────
// apps/rider-app/src/services/OfflineQueueService.ts
import SQLite from 'react-native-sqlite-storage';

const db = SQLite.openDatabase({ name: 'fleetos.db', location: 'default' });

class OfflineQueueService {
  async init() {
    return new Promise<void>((resolve) => {
      (db as any).transaction((tx: any) => {
        tx.executeSql(`CREATE TABLE IF NOT EXISTS offline_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          data TEXT NOT NULL,
          ts INTEGER NOT NULL,
          synced INTEGER DEFAULT 0
        )`);
        tx.executeSql(`CREATE TABLE IF NOT EXISTS pod_uploads (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          order_id TEXT NOT NULL,
          image_path TEXT NOT NULL,
          signature_path TEXT,
          otp TEXT,
          ts INTEGER NOT NULL,
          synced INTEGER DEFAULT 0
        )`);
      }, undefined, resolve);
    });
  }

  async enqueue(item: { type: string; data: object; ts: number }) {
    return new Promise<void>((resolve) => {
      (db as any).transaction((tx: any) => {
        tx.executeSql('INSERT INTO offline_queue (type, data, ts) VALUES (?, ?, ?)',
          [item.type, JSON.stringify(item.data), item.ts]);
      }, undefined, resolve);
    });
  }

  async drainToWebSocket(ws: WebSocketService) {
    (db as any).transaction((tx: any) => {
      tx.executeSql('SELECT * FROM offline_queue WHERE synced = 0 ORDER BY ts ASC LIMIT 50',
        [], (_tx: any, results: any) => {
          for (let i = 0; i < results.rows.length; i++) {
            const row = results.rows.item(i);
            try {
              ws.send({ ...JSON.parse(row.data), _offline: true });
              tx.executeSql('UPDATE offline_queue SET synced = 1 WHERE id = ?', [row.id]);
            } catch {}
          }
        });
    });
  }

  async savePOD(orderId: string, imagePath: string, signaturePath: string, otp: string) {
    return new Promise<void>((resolve) => {
      (db as any).transaction((tx: any) => {
        tx.executeSql(
          'INSERT INTO pod_uploads (order_id, image_path, signature_path, otp, ts) VALUES (?,?,?,?,?)',
          [orderId, imagePath, signaturePath, otp, Date.now()]
        );
      }, undefined, resolve);
    });
  }
}

export const offlineQueue = new OfflineQueueService();
