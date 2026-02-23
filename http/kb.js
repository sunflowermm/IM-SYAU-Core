import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import paths from '#utils/paths.js';
import { HttpResponse } from '#utils/http-utils.js';
import { findBeacon, getValidReceivers } from '../utils/ble-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORE_DIR = path.join(__dirname, '..');
const KB_DATA_DIR = path.join(CORE_DIR, 'www', 'kb', 'data');
const BLE_DATA_PATH = path.join(paths.data, 'blues', 'ble_data.json');

export default {
  name: 'kb',
  dsc: '知识库参观助手API',
  priority: 100,
  routes: [
    {
      method: 'GET',
      path: '/api/kb/exhibitions',
      handler: HttpResponse.asyncHandler(async (req, res) => {
        const file = path.join(KB_DATA_DIR, 'exhibitions.json');
        try {
          const content = await fs.readFile(file, 'utf-8');
          const data = JSON.parse(content);
          return res.json({ success: true, data, timestamp: Date.now() });
        } catch (err) {
          if (err.code === 'ENOENT') {
            return res.json({ success: true, data: {}, message: '展区信息文件不存在' });
          }
          throw err;
        }
      }, 'kb.exhibitions')
    },
    {
      method: 'GET',
      path: '/api/kb/prompts',
      handler: HttpResponse.asyncHandler(async (req, res) => {
        const file = path.join(KB_DATA_DIR, 'ai-prompts.json');
        try {
          const content = await fs.readFile(file, 'utf-8');
          const data = JSON.parse(content);
          return res.json({ success: true, data, timestamp: Date.now() });
        } catch (err) {
          if (err.code === 'ENOENT') {
            return res.json({ success: true, data: { prompts: [] }, message: 'AI问答配置文件不存在' });
          }
          throw err;
        }
      }, 'kb.prompts')
    },
    {
      method: 'POST',
      path: '/api/kb/ai-chat',
      handler: HttpResponse.asyncHandler(async (req, res) => {
        const { question, receiverId, beaconId } = req.body || {};
        if (!question) {
          return HttpResponse.validationError(res, '缺少问题参数');
        }
        const StreamLoader = (await import('#infrastructure/aistream/loader.js')).default;
        const stream = StreamLoader.getStream('kb-stream');
        if (!stream) {
          return res.status(503).json({
            success: false,
            message: '知识库工作流未就绪',
            data: { question, answer: '服务暂时不可用，请稍后重试。' }
          });
        }
        const e = { user_id: 'kb-api', reply: null };
        const input = { text: question, receiverId, beaconId };
        const answer = await stream.process(e, input, { enableTools: true });
        return res.json({
          success: true,
          data: {
            question,
            answer: answer && answer.trim() ? answer.trim() : '抱歉，未能生成有效回答，请换个方式提问。',
            receiverId,
            beaconId,
            timestamp: Date.now()
          }
        });
      }, 'kb.aiChat')
    },
    {
      method: 'POST',
      path: '/api/kb/exhibitions',
      handler: HttpResponse.asyncHandler(async (req, res, Bot) => {
        if (!Bot?.checkApiAuthorization?.(req)) {
          return HttpResponse.forbidden(res, '未授权访问');
        }
        const file = path.join(KB_DATA_DIR, 'exhibitions.json');
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify(req.body, null, 2), 'utf-8');
        return res.json({ success: true, message: '展区信息已更新' });
      }, 'kb.exhibitionsUpdate')
    },
    {
      method: 'GET',
      path: '/api/kb/beacon/:beaconId/receivers',
      handler: HttpResponse.asyncHandler(async (req, res) => {
        const { beaconId } = req.params;
        try {
          const content = await fs.readFile(BLE_DATA_PATH, 'utf-8');
          const data = JSON.parse(content);
          const found = findBeacon(data, beaconId);
          if (!found) {
            return HttpResponse.notFound(res, '未找到指定信标');
          }
          const now = Date.now();
          const receivers = getValidReceivers(found.beacon, now).map((r) => ({
            deviceId: r.deviceId,
            name: r.name,
            rssi: r.rssi,
            online: r.online,
            lastSeen: r.lastUpdateTime,
            timeDiff: now - r.lastUpdateTime,
            last_update: r.last_update
          }));
          return res.json({
            success: true,
            data: { beaconId: found.beacon.name, mac: found.mac, receivers, timestamp: now }
          });
        } catch (err) {
          if (err.code === 'ENOENT') {
            return HttpResponse.notFound(res, '蓝牙数据文件不存在');
          }
          throw err;
        }
      }, 'kb.beaconReceivers')
    },
    {
      method: 'GET',
      path: '/api/kb/visitor-stats',
      handler: HttpResponse.asyncHandler(async (req, res) => {
        const file = path.join(KB_DATA_DIR, 'visitor-stats.json');
        try {
          const content = await fs.readFile(file, 'utf-8');
          const data = JSON.parse(content);
          const list = Array.isArray(data) ? data : data?.list || [];
          return res.json({ success: true, data: list, timestamp: Date.now() });
        } catch (err) {
          if (err.code === 'ENOENT') {
            return res.json({ success: true, data: [], message: '暂无参观统计' });
          }
          throw err;
        }
      }, 'kb.visitorStats')
    }
  ]
};
