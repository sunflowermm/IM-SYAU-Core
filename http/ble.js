import fs from 'fs/promises';
import path from 'path';
import paths from '#utils/paths.js';
import { HttpResponse } from '#utils/http-utils.js';
import {
  decodeUnicode,
  findBeacon,
  getValidReceivers,
  getBeaconDisplayName,
  ACTIVE_WINDOW
} from '../utils/ble-utils.js';

const BLE_DATA_PATH = path.join(paths.data, 'blues', 'ble_data.json');

/**
 * 蓝牙信标数据 API
 * 提供蓝牙信标数据查询功能
 */
export default {
  name: 'ble',
  dsc: '蓝牙信标数据API',
  priority: 100,
  routes: [
    {
      method: 'GET',
      path: '/api/ble/data',
      handler: HttpResponse.asyncHandler(async (req, res) => {
        try {
          const content = await fs.readFile(BLE_DATA_PATH, 'utf-8');
          const data = JSON.parse(content);
          if (!Object.keys(data.devices || {}).length && !Object.keys(data.beacons || {}).length) {
            return res.json({ success: true, data: { devices: {}, beacons: {} }, message: '暂无数据' });
          }
          const simplified = { devices: {}, beacons: {} };
          for (const [deviceId, device] of Object.entries(data.devices || {})) {
            simplified.devices[deviceId] = { ...device, name: decodeUnicode(device.name) };
          }
          for (const [mac, beacon] of Object.entries(data.beacons || {})) {
            simplified.beacons[mac] = {
              name: beacon.name,
              first_seen: beacon.first_seen,
              detections: {}
            };
            for (const [deviceId, detection] of Object.entries(beacon.detections || {})) {
              simplified.beacons[mac].detections[deviceId] = {
                receiver: decodeUnicode(detection.receiver_name || detection.receiver),
                rssi: detection.rssi,
                online: detection.online,
                last_update: new Date(detection.update_time || 0).toLocaleString('zh-CN')
              };
            }
          }
          return res.json({ success: true, data: simplified, timestamp: Date.now() });
        } catch (err) {
          if (err.code === 'ENOENT') {
            return res.json({ success: true, data: { devices: {}, beacons: {} }, message: '数据文件不存在' });
          }
          throw err;
        }
      }, 'ble.data')
    },
    {
      method: 'GET',
      path: '/api/ble/esp-c3-beacons',
      handler: HttpResponse.asyncHandler(async (req, res) => {
        try {
          const content = await fs.readFile(BLE_DATA_PATH, 'utf-8');
          const data = JSON.parse(content);
          const now = Date.now();
          const espC3Beacons = [];
          for (const [mac, beacon] of Object.entries(data.beacons || {})) {
            if (!beacon.name?.startsWith('ESP-C3-') || !Object.keys(beacon.detections || {}).length) continue;
            const receivers = getValidReceivers(beacon, now);
            if (receivers.length === 0) continue;
            const detections = {};
            for (const r of receivers) {
              detections[r.deviceId] = {
                receiver: r.name,
                rssi: r.rssi,
                online: r.online,
                last_update: r.last_update
              };
            }
            espC3Beacons.push({
              mac,
              name: beacon.name,
              displayName: getBeaconDisplayName(beacon.name),
              detections,
              first_seen: beacon.first_seen
            });
          }
          espC3Beacons.sort((a, b) => {
            const aMax = Math.max(...Object.values(a.detections).map(d => d.rssi || -100));
            const bMax = Math.max(...Object.values(b.detections).map(d => d.rssi || -100));
            return bMax - aMax;
          });
          return res.json({ success: true, data: espC3Beacons, timestamp: Date.now() });
        } catch (err) {
          if (err.code === 'ENOENT') {
            return res.json({ success: true, data: [], message: '数据文件不存在' });
          }
          throw err;
        }
      }, 'ble.espC3Beacons')
    },
    {
      method: 'GET',
      path: '/api/ble/beacon/:beaconMac/receivers',
      handler: HttpResponse.asyncHandler(async (req, res) => {
        const { beaconMac } = req.params;
        try {
          const content = await fs.readFile(BLE_DATA_PATH, 'utf-8');
          const data = JSON.parse(content);
          const found = findBeacon(data, beaconMac);
          if (!found) {
            return HttpResponse.notFound(res, '未找到指定信标');
          }
          const now = Date.now();
          const receivers = getValidReceivers(found.beacon, now).map(r => ({
            receiverId: r.deviceId,
            receiver: r.name,
            rssi: r.rssi,
            online: r.online,
            last_update: r.last_update,
            lastUpdateTime: r.lastUpdateTime
          }));
          return res.json({
            success: true,
            data: {
              beaconId: found.beacon.name,
              beaconMac: found.mac,
              displayName: getBeaconDisplayName(found.beacon.name),
              receivers,
              timestamp: now
            }
          });
        } catch (err) {
          if (err.code === 'ENOENT') {
            return HttpResponse.notFound(res, '蓝牙数据文件不存在');
          }
          throw err;
        }
      }, 'ble.beaconReceivers')
    },
    {
      method: 'GET',
      path: '/api/ble/status',
      handler: HttpResponse.asyncHandler(async (req, res) => {
        try {
          const content = await fs.readFile(BLE_DATA_PATH, 'utf-8');
          const data = JSON.parse(content);
          const now = Date.now();
          const devices = data.devices || {};
          const totalReceivers = Object.keys(devices).length;
          const activeReceivers = Object.values(devices).filter(d => now - (d.update || 0) <= ACTIVE_WINDOW).length;
          const beacons = data.beacons || {};
          const totalBeacons = Object.keys(beacons).length;
          let activeBeacons = 0;
          for (const b of Object.values(beacons)) {
            for (const d of Object.values(b.detections || {})) {
              if (d.online && now - (d.update_time || 0) <= ACTIVE_WINDOW) {
                activeBeacons++;
                break;
              }
            }
          }
          return res.json({
            success: true,
            status: {
              receivers: { total: totalReceivers, active: activeReceivers },
              beacons: { total: totalBeacons, active: activeBeacons },
              active_window: ACTIVE_WINDOW,
              timestamp: now
            }
          });
        } catch (err) {
          if (err.code === 'ENOENT') {
            return res.json({
              success: true,
              status: { receivers: { total: 0, active: 0 }, beacons: { total: 0, active: 0 }, active_window: ACTIVE_WINDOW, timestamp: Date.now() }
            });
          }
          throw err;
        }
      }, 'ble.status')
    },
    {
      method: 'DELETE',
      path: '/api/ble/data',
      handler: HttpResponse.asyncHandler(async (req, res, Bot) => {
        if (!Bot?.checkApiAuthorization?.(req)) {
          return HttpResponse.forbidden(res, '未授权');
        }
        await fs.mkdir(path.dirname(BLE_DATA_PATH), { recursive: true });
        await fs.writeFile(BLE_DATA_PATH, JSON.stringify({ devices: {}, beacons: {} }, null, 2));
        return res.json({ success: true, message: '蓝牙数据已重置' });
      }, 'ble.reset')
    }
  ]
};
