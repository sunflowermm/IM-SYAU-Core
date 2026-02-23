/**
 * IM-SYAU-Core 蓝牙相关共享工具
 * 供 http/ble.js、http/kb.js 复用
 */

/** 检测超时阈值（毫秒），15 秒未更新视为超时 */
export const STALE_TIME_THRESHOLD = 15000;

/** 活跃窗口（毫秒），10 秒内认为在线 */
export const ACTIVE_WINDOW = 10000;

/**
 * Unicode 解码（\uXXXX -> 字符）
 * @param {string} str
 * @returns {string}
 */
export function decodeUnicode(str) {
  if (!str || typeof str !== 'string') return str;
  try {
    return str.replace(/\\u[\dA-F]{4}/gi, (match) => {
      return String.fromCharCode(parseInt(match.replace(/\\u/g, ''), 16));
    });
  } catch {
    return str;
  }
}

/**
 * 解析检测时间（支持 update_time 或 "2025/11/7 20:32:24" 格式）
 * @param {Object} detection
 * @returns {number|null} 时间戳，解析失败返回 null
 */
export function parseDetectionTime(detection) {
  if (!detection) return null;
  if (detection.update_time) return detection.update_time;
  if (!detection.last_update) return null;
  try {
    const [datePart, timePart] = detection.last_update.split(' ');
    const [year, month, day] = datePart.split('/').map(Number);
    const [hour, minute, second] = timePart.split(':').map(Number);
    return new Date(year, month - 1, day, hour, minute, second).getTime();
  } catch {
    return null;
  }
}

/**
 * 检查检测是否超时
 * @param {Object} detection
 * @param {number} now
 * @param {number} [threshold=STALE_TIME_THRESHOLD]
 * @returns {boolean}
 */
export function isDetectionStale(detection, now, threshold = STALE_TIME_THRESHOLD) {
  const lastUpdateTime = parseDetectionTime(detection);
  if (lastUpdateTime == null) return true;
  return (now - lastUpdateTime) > threshold;
}

/**
 * 获取信标（按名称或 MAC）
 * @param {Object} data - ble_data.json 根对象
 * @param {string} beaconId - 信标名称或 MAC
 * @returns {{ beacon: Object, mac: string }|null}
 */
export function findBeacon(data, beaconId) {
  if (!data?.beacons) return null;
  for (const [mac, beacon] of Object.entries(data.beacons)) {
    if (beacon.name === beaconId || mac === beaconId) {
      return { beacon, mac };
    }
  }
  return null;
}

/**
 * 获取有效的接收器列表（未超时）
 * @param {Object} beacon - 信标对象
 * @param {number} now
 * @param {number} [threshold=STALE_TIME_THRESHOLD]
 * @returns {Array<{deviceId: string, name: string, rssi: number, online: boolean, lastUpdateTime: number, last_update: string}>}
 */
export function getValidReceivers(beacon, now, threshold = STALE_TIME_THRESHOLD) {
  const receivers = [];
  const detections = beacon?.detections || {};
  for (const [deviceId, detection] of Object.entries(detections)) {
    const lastUpdateTime = parseDetectionTime(detection);
    if (lastUpdateTime == null) continue;
    const timeSinceUpdate = now - lastUpdateTime;
    if (timeSinceUpdate <= threshold) {
      receivers.push({
        deviceId,
        name: decodeUnicode(detection.receiver_name || detection.receiver),
        rssi: detection.rssi ?? -100,
        online: detection.online || false,
        lastUpdateTime,
        last_update: new Date(lastUpdateTime).toLocaleString('zh-CN')
      });
    }
  }
  receivers.sort((a, b) => b.rssi - a.rssi);
  return receivers;
}

/**
 * 提取信标显示名称（ESP-C3-1 -> 1号信标）
 * @param {string} beaconName
 * @returns {string}
 */
export function getBeaconDisplayName(beaconName) {
  if (!beaconName) return '未知信标';
  const match = beaconName.match(/ESP-C3-(\d+)/);
  if (match?.[1]) return `${match[1]}号信标`;
  return beaconName;
}
