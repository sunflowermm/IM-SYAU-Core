import path from 'path';
import fs from 'fs/promises';
import paths from '#utils/paths.js';
import { decodeUnicode, ACTIVE_WINDOW } from '../utils/ble-utils.js';

export default class DeviceBLE extends plugin {
  constructor() {
    super({
      name: '蓝牙信标管理',
      dsc: '管理和分析ESP32设备的蓝牙信标扫描数据（以信标为主体）',
      event: 'message',
      priority: 500,
      rule: [
        { reg: '^#蓝牙(现状|情况|状态|详情)$', fnc: 'showBLEStatus' },
        { reg: '^#蓝牙列表$', fnc: 'showBeaconList' },
        { reg: '^#蓝牙详情\\s+(.+)$', fnc: 'showBeaconDetail' },
        { reg: '^#蓝牙重置$', fnc: 'resetBLEData' },
        { reg: '^#蓝牙json$', fnc: 'exportJSON' },
        { reg: '^#蓝牙统计$', fnc: 'showStatistics' }
      ]
    });
    this.dataFile = path.join(paths.data, 'blues', 'ble_data.json');
    this.dataPath = path.dirname(this.dataFile);
    
    // 设置定时任务
    this.task = {
      name: '蓝牙数据清理',
      cron: '0 */30 * * * *',
      fnc: () => this.autoClearOldData()
    };
  }

  async init() {
    try {
      await fs.mkdir(this.dataPath, { recursive: true });
      await this.checkAndRepairDataFile();
      logger.mark(`[蓝牙插件] 初始化完成 - 信标主体模式`);
    } catch (err) {
      logger.error(`[蓝牙插件] 初始化失败: ${err.message}`);
    }
    
    setTimeout(() => {
      Bot.on('device.ble_beacon_batch', async (e) => {
        await this.handleBLEData(e);
      });
      
      Bot.on('device.data', async (e) => {
        if (e.event_data?.data_type === 'ble_beacon_batch') {
          await this.handleBLEData(e);
        }
      });
      
      logger.mark('[蓝牙插件] 事件监听器已注册');
    }, 1000);
  }

  /**
   * 递归解码对象中的所有 Unicode 字符串（复用 ble-utils.decodeUnicode）
   */
  decodeObject(obj) {
    if (typeof obj === 'string') {
      return decodeUnicode(obj);
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.decodeObject(item));
    }
    
    if (obj !== null && typeof obj === 'object') {
      const decoded = {};
      for (const [key, value] of Object.entries(obj)) {
        decoded[key] = this.decodeObject(value);
      }
      return decoded;
    }
    
    return obj;
  }

  async checkAndRepairDataFile() {
    try {
      const content = await fs.readFile(this.dataFile, 'utf-8');
      JSON.parse(content);
    } catch (err) {
      if (err.code === 'ENOENT' || err instanceof SyntaxError) {
        await this.saveData({ 
          devices: {},
          beacons: {}
        });
        logger.mark('[蓝牙插件] 初始化数据文件');
      }
    }
  }

  async loadData() {
    try {
      const content = await fs.readFile(this.dataFile, 'utf-8');
      const data = JSON.parse(content);
      
      // 解码所有Unicode转义序列
      const decoded = this.decodeObject(data);
      
      if (!decoded.devices) decoded.devices = {};
      if (!decoded.beacons) decoded.beacons = {};
      
      return decoded;
    } catch (err) {
      return { devices: {}, beacons: {} };
    }
  }

  async saveData(data) {
    try {
      await fs.writeFile(this.dataFile, JSON.stringify(data, null, 2));
      return true;
    } catch (err) {
      logger.error(`[蓝牙插件] 保存数据失败: ${err.message}`);
      return false;
    }
  }

  async handleBLEData(e) {
    try {
      const deviceId = e.device_id;
      const reportData = e.event_data || {};
      let beacons = reportData.beacons || [];
      
      if (!deviceId || !beacons.length) return;
      
      const data = await this.loadData();
      const now = Date.now();
      
      // 更新接收器信息
      data.devices[deviceId] = {
        name: e.device_name || deviceId,
        type: e.device_type || 'ESP32',
        update: now,
        batch: reportData.batch || 1,
        total_batches: reportData.total_batches || 1
      };
      
      // 更新全局信标信息
      for (const beacon of beacons) {
        if (!beacon.mac) continue;
        
        if (!data.beacons[beacon.mac]) {
          data.beacons[beacon.mac] = {
            name: beacon.name,
            first_seen: now,
            detections: {}
          };
        }
        
        if (beacon.name) {
          data.beacons[beacon.mac].name = beacon.name;
        }
        
        let rssiValue = beacon.rssi;
        if (typeof beacon.rssi === 'object') {
          rssiValue = beacon.rssi.average || beacon.rssi.current || beacon.rssi;
        }
        
        data.beacons[beacon.mac].detections[deviceId] = {
          receiver_name: e.device_name || deviceId,
          online: beacon.online,
          rssi: rssiValue,
          last_seen: now,
          update_time: now
        };
      }
      
      await this.saveData(data);
      
      const batchInfo = reportData.batch && reportData.total_batches > 1 ? 
        ` (批${reportData.batch}/${reportData.total_batches})` : '';
      logger.mark(`[蓝牙插件] ${e.device_name || deviceId} 上报 ${beacons.length} 个信标${batchInfo}`);
      
    } catch (error) {
      logger.error(`[蓝牙插件] 处理数据失败: ${error.message}`);
    }
  }

  /**
   * 显示蓝牙状态 - 以信标为主体
   */
  async showBLEStatus(e) {
    const data = await this.loadData();
    if (!data.beacons || !Object.keys(data.beacons).length) {
      await e.reply('暂无蓝牙信标数据');
      return true;
    }
    const now = Date.now();
    
    const activeBeacons = [];
    
    for (const [mac, beaconData] of Object.entries(data.beacons)) {
      const receivers = [];
      
      for (const [deviceId, detection] of Object.entries(beaconData.detections || {})) {
        const timeDiff = now - detection.update_time;
        
        if (detection.online && timeDiff <= ACTIVE_WINDOW) {
          receivers.push({
            deviceId,
            name: detection.receiver_name,
            rssi: Number(detection.rssi) || -100,
            lastSeen: detection.update_time,
            timeDiff
          });
        }
      }
      
      if (receivers.length > 0) {
        receivers.sort((a, b) => b.rssi - a.rssi);
        
        activeBeacons.push({
          mac,
          name: beaconData.name,
          receivers,
          strongestRssi: receivers[0].rssi
        });
      }
    }
    
    if (activeBeacons.length === 0) {
      await e.reply('暂无活跃的蓝牙信标（10秒内）');
      return true;
    }
    
    activeBeacons.sort((a, b) => b.strongestRssi - a.strongestRssi);
    
    let msg = ['📡 蓝牙信标状态（信标主体视图）\n'];
    msg.push('═══════════════════════════\n\n');
    
    const displayBeacons = activeBeacons.slice(0, 15);
    
    for (const beacon of displayBeacons) {
      msg.push(`🔵 ${beacon.name}\n`);
      msg.push(`   MAC: ${beacon.mac}\n`);
      msg.push(`   被 ${beacon.receivers.length} 个接收器检测到：\n\n`);
      
      for (let i = 0; i < beacon.receivers.length; i++) {
        const receiver = beacon.receivers[i];
        const seconds = Math.floor(receiver.timeDiff / 1000);
        const timeStr = seconds === 0 ? '刚刚' : `${seconds}秒前`;
        
        const badge = i === 0 ? '🏆 ' : '   ';
        
        let signalLevel = '';
        if (receiver.rssi >= -60) signalLevel = '📶强';
        else if (receiver.rssi >= -70) signalLevel = '📶中';
        else if (receiver.rssi >= -80) signalLevel = '📶弱';
        else signalLevel = '📶极弱';
        
        msg.push(`${badge}${signalLevel} ${receiver.name}\n`);
        msg.push(`      信号: ${receiver.rssi}dBm | ${timeStr}\n`);
      }
      msg.push('\n');
    }
    
    if (activeBeacons.length > 15) {
      msg.push(`... 还有 ${activeBeacons.length - 15} 个活跃信标\n\n`);
    }
    
    const totalDevices = Object.keys(data.devices).length;
    const totalBeacons = Object.keys(data.beacons).length;
    const activeDevices = Object.values(data.devices).filter(d => 
      now - d.update <= ACTIVE_WINDOW
    ).length;
    
    msg.push('═══════════════════════════\n');
    msg.push(`📊 统计: ${activeDevices}/${totalDevices}活跃接收器 | `);
    msg.push(`${activeBeacons.length}/${totalBeacons}活跃信标\n`);
    msg.push(`💡 提示: 发送 #蓝牙列表 查看完整列表`);
    await e.reply(msg.join(''));
    return true;
  }

  async showBeaconList(e) {
    const data = await this.loadData();
    if (!data.beacons || !Object.keys(data.beacons).length) {
      await e.reply('暂无蓝牙信标数据');
      return true;
    }
    const now = Date.now();
    
    const beaconList = [];
    
    for (const [mac, beaconData] of Object.entries(data.beacons)) {
      let activeReceivers = 0;
      let strongestRssi = -100;
      let newestUpdate = 0;
      
      for (const detection of Object.values(beaconData.detections || {})) {
        if (detection.online && now - detection.update_time <= ACTIVE_WINDOW) {
          activeReceivers++;
          if (detection.rssi > strongestRssi) {
            strongestRssi = detection.rssi;
          }
        }
        if (detection.update_time > newestUpdate) {
          newestUpdate = detection.update_time;
        }
      }
      
      beaconList.push({
        mac,
        name: beaconData.name,
        activeReceivers,
        strongestRssi,
        newestUpdate,
        isActive: activeReceivers > 0
      });
    }
    
    beaconList.sort((a, b) => {
      if (a.isActive !== b.isActive) return b.isActive - a.isActive;
      return b.strongestRssi - a.strongestRssi;
    });
    
    let msg = ['📋 蓝牙信标完整列表\n'];
    msg.push('═══════════════════════════\n\n');
    
    for (const beacon of beaconList) {
      const status = beacon.isActive ? '🟢活跃' : '🔴离线';
      const timeDiff = now - beacon.newestUpdate;
      const minutes = Math.floor(timeDiff / 60000);
      const timeStr = minutes < 1 ? '刚刚' : 
                      minutes < 60 ? `${minutes}分钟前` : 
                      `${Math.floor(minutes / 60)}小时前`;
      
      msg.push(`${status} ${beacon.name}\n`);
      msg.push(`   MAC: ${beacon.mac}\n`);
      
      if (beacon.isActive) {
        msg.push(`   检测器: ${beacon.activeReceivers}个 | `);
        msg.push(`最强信号: ${beacon.strongestRssi}dBm\n`);
      } else {
        msg.push(`   最后检测: ${timeStr}\n`);
      }
      msg.push('\n');
    }
    
    msg.push('═══════════════════════════\n');
    msg.push(`总计: ${beaconList.length} 个信标\n`);
    msg.push(`💡 发送 #蓝牙详情 [名称] 查看详情`);
    await e.reply(msg.join(''));
    return true;
  }

  async showBeaconDetail(e) {
    const name = e.msg.replace(/^#蓝牙详情\s+/, '').trim();
    if (!name) {
      await e.reply('请指定信标名称，例如：#蓝牙详情 ESP-C3-003');
      return true;
    }
    const data = await this.loadData();
    const now = Date.now();
    
    let targetBeacon = null;
    let targetMac = null;
    
    for (const [mac, beaconData] of Object.entries(data.beacons)) {
      if (beaconData.name && beaconData.name.includes(name)) {
        targetBeacon = beaconData;
        targetMac = mac;
        break;
      }
    }
    
    if (!targetBeacon) {
      await e.reply(`未找到名称包含 "${name}" 的信标`);
      return true;
    }
    
    let msg = [`🔍 信标详细信息\n`];
    msg.push('═══════════════════════════\n\n');
    msg.push(`📍 名称: ${targetBeacon.name}\n`);
    msg.push(`🔖 MAC: ${targetMac}\n`);
    
    const firstSeen = new Date(targetBeacon.first_seen);
    msg.push(`🕐 首次发现: ${firstSeen.toLocaleString('zh-CN')}\n\n`);
    
    const allDetections = [];
    
    for (const [deviceId, detection] of Object.entries(targetBeacon.detections || {})) {
      const timeDiff = now - detection.update_time;
      allDetections.push({
        deviceId,
        name: detection.receiver_name,
        rssi: detection.rssi,
        online: detection.online,
        lastSeen: detection.update_time,
        timeDiff,
        isRecent: timeDiff <= 10000
      });
    }
    
    allDetections.sort((a, b) => {
      if (a.isRecent !== b.isRecent) return b.isRecent - a.isRecent;
      if (a.isRecent) return b.rssi - a.rssi;
      return b.lastSeen - a.lastSeen;
    });
    
    msg.push(`📡 检测历史 (${allDetections.length}个接收器):\n\n`);
    
    for (const detection of allDetections) {
      const status = detection.isRecent ? '🟢在线' : '🔴离线';
      const minutes = Math.floor(detection.timeDiff / 60000);
      const timeStr = minutes < 1 ? '刚刚' : 
                      minutes < 60 ? `${minutes}分钟前` : 
                      `${Math.floor(minutes / 60)}小时前`;
      
      msg.push(`${status} ${detection.name}\n`);
      msg.push(`   ID: ${detection.deviceId}\n`);
      msg.push(`   信号: ${detection.rssi}dBm | ${timeStr}\n\n`);
    }
    
    const recentDetections = allDetections.filter(d => d.isRecent);
    if (recentDetections.length > 0) {
      const avgRssi = recentDetections.reduce((sum, d) => sum + d.rssi, 0) / recentDetections.length;
      const maxRssi = Math.max(...recentDetections.map(d => d.rssi));
      const minRssi = Math.min(...recentDetections.map(d => d.rssi));
      
      msg.push('═══════════════════════════\n');
      msg.push('📊 当前统计:\n');
      msg.push(`   平均信号: ${avgRssi.toFixed(1)}dBm\n`);
      msg.push(`   最强信号: ${maxRssi}dBm\n`);
      msg.push(`   最弱信号: ${minRssi}dBm\n`);
    }
    await e.reply(msg.join(''));
    return true;
  }

  async showStatistics(e) {
    const data = await this.loadData();
    const now = Date.now();
    
    const totalReceivers = Object.keys(data.devices).length;
    const activeReceivers = Object.values(data.devices).filter(d => 
      now - d.update <= ACTIVE_WINDOW
    ).length;
    
    const totalBeacons = Object.keys(data.beacons).length;
    let activeBeacons = 0;
    let multiReceiverBeacons = 0;
    let singleReceiverBeacons = 0;
    
    const rssiValues = [];
    
    for (const beaconData of Object.values(data.beacons)) {
      let activeCount = 0;
      
      for (const detection of Object.values(beaconData.detections || {})) {
        if (detection.online && now - detection.update_time <= ACTIVE_WINDOW) {
          activeCount++;
          rssiValues.push(detection.rssi);
        }
      }
      
      if (activeCount > 0) {
        activeBeacons++;
        if (activeCount > 1) multiReceiverBeacons++;
        else singleReceiverBeacons++;
      }
    }
    
    let avgRssi = 0;
    let maxRssi = -100;
    let minRssi = 0;
    
    if (rssiValues.length > 0) {
      avgRssi = rssiValues.reduce((a, b) => a + b, 0) / rssiValues.length;
      maxRssi = Math.max(...rssiValues);
      minRssi = Math.min(...rssiValues);
    }
    
    let msg = ['📊 蓝牙系统统计\n'];
    msg.push('═══════════════════════════\n\n');
    
    msg.push('🔧 接收器:\n');
    msg.push(`   总数: ${totalReceivers}个\n`);
    msg.push(`   活跃: ${activeReceivers}个\n\n`);
    
    msg.push('📡 信标:\n');
    msg.push(`   总数: ${totalBeacons}个\n`);
    msg.push(`   活跃: ${activeBeacons}个\n`);
    msg.push(`   多接收器覆盖: ${multiReceiverBeacons}个\n`);
    msg.push(`   单接收器覆盖: ${singleReceiverBeacons}个\n\n`);
    
    if (rssiValues.length > 0) {
      msg.push('📶 信号强度:\n');
      msg.push(`   平均: ${avgRssi.toFixed(1)}dBm\n`);
      msg.push(`   最强: ${maxRssi}dBm\n`);
      msg.push(`   最弱: ${minRssi}dBm\n`);
      msg.push(`   采样数: ${rssiValues.length}\n\n`);
    }
    
    msg.push('═══════════════════════════\n');
    const updateTime = new Date().toLocaleTimeString('zh-CN');
    msg.push(`⏰ 更新时间: ${updateTime}`);
    await e.reply(msg.join(''));
    return true;
  }

  async resetBLEData(e) {
    await this.saveData({ devices: {}, beacons: {} });
    await e.reply('✅ 蓝牙数据已重置');
    return true;
  }

  async exportJSON(e) {
    const data = await this.loadData();
    if ((!data.devices || !Object.keys(data.devices).length) &&
        (!data.beacons || !Object.keys(data.beacons).length)) {
      await e.reply('暂无数据');
      return true;
    }
    
    const simplified = {
      devices: data.devices,
      beacons: {}
    };
    
    for (const [mac, beacon] of Object.entries(data.beacons || {})) {
      simplified.beacons[mac] = {
        name: beacon.name,
        detections: {}
      };
      for (const [deviceId, detection] of Object.entries(beacon.detections || {})) {
        simplified.beacons[mac].detections[deviceId] = {
          receiver: detection.receiver_name,
          rssi: detection.rssi,
          online: detection.online,
          last_update: new Date(detection.update_time).toLocaleString('zh-CN')
        };
      }
    }
    
    const jsonStr = JSON.stringify(simplified, null, 2);
    
    if (jsonStr.length > 3000) {
      const truncated = jsonStr.substring(0, 2900) + '\n... (数据过长已截断)';
      await e.reply(`\`\`\`json\n${truncated}\n\`\`\``);
    } else {
      await e.reply(`\`\`\`json\n${jsonStr}\n\`\`\``);
    }
    return true;
  }

  async autoClearOldData() {
    const data = await this.loadData();
    
    const now = Date.now();
    const halfHour = 30 * 60 * 1000;
    
    let cleaned = 0;
    
    for (const deviceId in data.devices) {
      if (now - data.devices[deviceId].update > halfHour) {
        delete data.devices[deviceId];
        cleaned++;
      }
    }
    
    for (const mac in data.beacons) {
      const beacon = data.beacons[mac];
      let hasRecentDetection = false;
      
      for (const deviceId in beacon.detections) {
        if (now - beacon.detections[deviceId].update_time > halfHour) {
          delete beacon.detections[deviceId];
          cleaned++;
        } else {
          hasRecentDetection = true;
        }
      }
      
      if (!hasRecentDetection) {
        delete data.beacons[mac];
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      await this.saveData(data);
      logger.mark(`[蓝牙插件] 自动清理 ${cleaned} 条过期数据`);
    }
  }
}