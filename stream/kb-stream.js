import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import AIStream from '../../../src/infrastructure/aistream/aistream.js';
import BotUtil from '../../../src/utils/botutil.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

let exhibitionsCache = null;
let knowledgeCache = null;

async function loadExhibitions() {
  if (exhibitionsCache) return exhibitionsCache;
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, 'exhibitions.json'), 'utf-8');
    exhibitionsCache = JSON.parse(raw);
    return exhibitionsCache;
  } catch (err) {
    BotUtil.makeLog('warn', `[kb-stream] 读取展区数据失败: ${err.message}`, 'KbStream');
    return {};
  }
}

async function loadKnowledge() {
  if (knowledgeCache) return knowledgeCache;
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, 'knowledge.json'), 'utf-8');
    knowledgeCache = JSON.parse(raw);
    return Array.isArray(knowledgeCache) ? knowledgeCache : [];
  } catch (err) {
    BotUtil.makeLog('warn', `[kb-stream] 读取知识库失败: ${err.message}`, 'KbStream');
    return [];
  }
}

/**
 * 昆虫博物馆知识库工作流
 * 注册 MCP 工具供 AI 查询展区与知识库，回答游客问题
 */
export default class KbStream extends AIStream {
  constructor() {
    super({
      name: 'kb-stream',
      description: '沈阳农业大学昆虫博物馆知识库导览',
      version: '1.0.0',
      priority: 100,
      config: { enabled: true },
      embedding: { enabled: false }
    });
  }

  async init() {
    await super.init();
    this.registerKbTools();
    BotUtil.makeLog('info', `工作流 "${this.name}" 已初始化`, 'KbStream');
    return true;
  }

  buildSystemPrompt() {
    return `你是沈阳农业大学昆虫博物馆的专业智能导览助手。请用简洁、友好、准确的语言回答参观者问题。
回答前请优先使用工具查询展区信息和知识库，再结合结果组织回答。回答控制在200字以内，除非问题需要展开。
若问题超出博物馆与昆虫范围，可礼貌引导到本馆展区内容。`;
  }

  registerKbTools() {
    this.registerMCPTool('get_exhibition_list', {
      description: '获取所有展区列表，用于了解馆内有哪些展区及对应ID',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const data = await loadExhibitions();
        const list = Object.entries(data || {}).map(([id, v]) => ({ id, name: v.name, description: v.description }));
        return this.successResponse({ exhibitions: list });
      }
    });

    this.registerMCPTool('get_exhibition_detail', {
      description: '根据展区ID（如 ESP32-001）获取该展区的名称、描述、详情与亮点，用于回答某展区相关问题',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: '展区ID，如 ESP32-001' } },
        required: ['id']
      },
      handler: async (params = {}) => {
        const { id } = params;
        if (!id) return this.errorResponse('MISSING_ID', '缺少展区ID');
        const data = await loadExhibitions();
        const ex = data?.[id];
        if (!ex) return this.errorResponse('NOT_FOUND', `未找到展区: ${id}`);
        return this.successResponse({ id, ...ex });
      }
    });

    this.registerMCPTool('search_knowledge', {
      description: '按关键词在博物馆知识库中检索与昆虫、展区相关的简短答案，用于回答具体知识点问题',
      inputSchema: {
        type: 'object',
        properties: { keyword: { type: 'string', description: '关键词，如：绿尾大蚕蛾、天牛触角、蝼蛄' } },
        required: ['keyword']
      },
      handler: async (params = {}) => {
        const { keyword } = params;
        if (!keyword || !String(keyword).trim()) return this.errorResponse('MISSING_KEYWORD', '缺少关键词');
        const list = await loadKnowledge();
        const k = String(keyword).trim().toLowerCase();
        const matched = list.filter(
          (item) => (item.keywords || []).some((kw) => String(kw).toLowerCase().includes(k) || k.includes(String(kw).toLowerCase()))
        );
        const contents = matched.map((m) => m.content);
        return this.successResponse({ keyword, count: contents.length, results: contents });
      }
    });
  }
}
