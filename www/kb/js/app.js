// ==================== 全局状态管理 ====================
/**
 * 应用全局状态管理对象
 * 统一管理应用的所有状态，便于扩展和维护
 */
const AppState = {
  // 信标相关状态
  currentBeaconId: null,        // 当前选中的信标ID
  currentBeaconMac: null,       // 当前信标的MAC地址
  currentReceiverId: null,      // 当前接收器ID
  currentExhibitionId: null,    // 当前展区ID
  
  // 数据状态
  bleData: null,                // 蓝牙数据
  exhibitions: null,            // 展区数据
  aiPrompts: null,              // AI提示词数据
  
  // 页面状态
  updateTimer: null,            // 数据更新定时器
  previousPage: null,           // 上一个页面ID
  
  // 彩蛋相关状态
  logoClickCount: 0,            // Logo点击次数
  lastLogoClickTime: 0,         // 上次点击Logo的时间（用于重置计数）
  
  // 信号检测相关（用于优化）
  rssiHistory: {},              // RSSI历史记录：{ beaconMac: { receiverId: [{ rssi, timestamp }] } }
  lastValidReceiverCount: 0,    // 上一次的有效接收器数量（用于稳定性检测）
  emptyCount: 0                  // 连续为0的次数（用于稳定性检测）
};

// ==================== API 配置（与后端路由一致）====================
const API = {
  BLE_DATA: '/api/ble/data',
  BLE_ESP_C3_BEACONS: '/api/ble/esp-c3-beacons',
  BLE_BEACON_RECEIVERS: '/api/ble/beacon/:beaconMac/receivers',
  EXHIBITIONS: '/api/kb/exhibitions',
  AI_PROMPTS: '/api/kb/prompts',
  AI_CHAT: '/api/kb/ai-chat',
  VISITOR_STATS: '/api/kb/visitor-stats'
};

/** 统一请求：GET 返回 { ok, data, message }；POST 同结构，失败时 message 为后端 message 或默认文案 */
async function apiGet(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  const ok = res.ok && body.success !== false;
  return { ok, data: body.data ?? body, message: body.message || (res.ok ? '' : '请求失败') };
}

async function apiPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  const ok = res.ok && data.success !== false;
  return { ok, data: data.data ?? data, message: data.message || (res.ok ? '' : '请求失败') };
}

// ==================== 页面初始化 ====================
document.addEventListener('DOMContentLoaded', async () => {
  showLoading();
  try {
    await Promise.all([loadBLEData(), loadExhibitions(), loadAIPrompts()]);
    await renderBeaconChips();
    initEventListeners();
    initVisitorCharts();
    initParticles();
    startUpdateTimer();
  } catch (error) {
    alert('加载数据失败，请刷新页面重试');
  } finally {
    hideLoading();
  }
});

// ==================== 数据加载（对接后端 /api/ble、/api/kb）====================
async function loadBLEData() {
  const { ok, data } = await apiGet(API.BLE_DATA);
  AppState.bleData = ok && data ? data : { devices: {}, beacons: {} };
}

async function loadESPC3Beacons() {
  const { ok, data } = await apiGet(API.BLE_ESP_C3_BEACONS);
  return ok && Array.isArray(data) ? data : [];
}

async function loadBeaconReceivers(beaconMac) {
  const url = API.BLE_BEACON_RECEIVERS.replace(':beaconMac', encodeURIComponent(beaconMac));
  const { ok, data } = await apiGet(url);
  return ok && data ? data : { receivers: [], displayName: '' };
}

async function loadExhibitions() {
  const { ok, data } = await apiGet(API.EXHIBITIONS);
  AppState.exhibitions = ok && data && typeof data === 'object' ? data : {};
}

async function loadAIPrompts() {
  const { ok, data } = await apiGet(API.AI_PROMPTS);
  AppState.aiPrompts = ok && data ? data : { prompts: [] };
}

// ==================== 事件监听初始化 ====================
function initEventListeners() {
  // 初始页面返回按钮（暂时没有，因为是首页）
  
  // Logo点击计数 - 彩蛋功能
  initEasterEgg();
  
  // 列表页返回按钮
  const listBackBtn = document.getElementById('list-back-btn');
  if (listBackBtn) {
    listBackBtn.addEventListener('click', () => {
      navigateToPage('init-page', 'list-page');
      clearUpdateTimer();
    });
  }
  
  // 彩蛋页面返回按钮
  const easterEggBackBtn = document.getElementById('easter-egg-back-btn');
  if (easterEggBackBtn) {
    easterEggBackBtn.addEventListener('click', () => {
      navigateToPage('init-page', 'easter-egg-page');
    });
  }
  
  // 详情页返回按钮
  const detailBackBtn = document.getElementById('detail-back-btn');
  if (detailBackBtn) {
    detailBackBtn.addEventListener('click', () => {
      navigateToPage('list-page', 'detail-page');
      // 清除AI问答内容
      clearAIAnswer();
    });
  }
  
  // 许可证页返回按钮
  const licenseBackBtn = document.getElementById('license-back-btn');
  if (licenseBackBtn) {
    licenseBackBtn.addEventListener('click', () => {
      const previousPage = AppState.previousPage || 'init-page';
      navigateToPage(previousPage, 'license-page');
    });
  }
  
  // AI问答按钮
  const askBtn = document.getElementById('ask-btn');
  if (askBtn) {
    askBtn.addEventListener('click', handleAIQuestion);
  }
  
  // 回车发送
  const customInput = document.getElementById('custom-input');
  if (customInput) {
    customInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleAIQuestion();
      }
    });
  }
  
  // ==================== 悬浮AI聊天按钮初始化 ====================
  /**
   * 初始化悬浮AI聊天按钮的拖拽和点击功能
   * 支持鼠标和触摸操作，区分点击和拖拽行为
   */
  const floatingAiBtn = document.getElementById('floating-ai-btn');
  const floatingAiClose = document.getElementById('floating-ai-close');
  const floatingAiWindow = document.getElementById('floating-ai-window');
  const floatingAiChat = document.getElementById('floating-ai-chat');
  
  // 添加拖拽功能
  if (floatingAiChat && floatingAiBtn) {
    let isDragging = false;        // 是否正在拖拽
    let hasMoved = false;           // 是否发生了移动（用于区分点击和拖拽）
    let startX = 0;                 // 拖拽开始时的鼠标/触摸X坐标
    let startY = 0;                 // 拖拽开始时的鼠标/触摸Y坐标
    let startLeft = 0;              // 拖拽开始时元素的left值
    let startTop = 0;               // 拖拽开始时元素的top值
    let animationFrameId = null;    // 动画帧ID，用于优化拖拽性能
    const DRAG_THRESHOLD = 5;       // 拖拽阈值（像素），用于区分点击和拖拽
    
    /**
     * 初始化悬浮球位置
     * 优先从localStorage恢复，否则使用默认位置（右下角）
     */
    function initFloatingPosition() {
      const savedPosition = localStorage.getItem('floatingAiPosition');
      
      if (savedPosition) {
        try {
          const pos = JSON.parse(savedPosition);
          // 如果保存了位置，使用保存的位置
          if (pos.left && pos.left !== 'auto' && pos.top && pos.top !== 'auto') {
            const leftValue = parseFloat(pos.left);
            const topValue = parseFloat(pos.top);
            
            // 验证位置是否在视口内
            const maxX = window.innerWidth - floatingAiChat.offsetWidth;
            const maxY = window.innerHeight - floatingAiChat.offsetHeight;
            
            const validLeft = Math.max(0, Math.min(leftValue, maxX));
            const validTop = Math.max(0, Math.min(topValue, maxY));
            
            floatingAiChat.style.left = validLeft + 'px';
            floatingAiChat.style.right = 'auto';
            floatingAiChat.style.top = validTop + 'px';
            floatingAiChat.style.bottom = 'auto';
            floatingAiChat.style.transform = 'none';
            
            return;
          }
        } catch (_e) {}
      }
      
      // 如果没有保存的位置，使用默认位置（右下角）
      const defaultRight = 20;
      const defaultBottom = 20;
      const defaultLeft = window.innerWidth - floatingAiChat.offsetWidth - defaultRight;
      const defaultTop = window.innerHeight - floatingAiChat.offsetHeight - defaultBottom;
      
      floatingAiChat.style.left = defaultLeft + 'px';
      floatingAiChat.style.right = 'auto';
      floatingAiChat.style.top = defaultTop + 'px';
      floatingAiChat.style.bottom = 'auto';
      floatingAiChat.style.transform = 'none';
    }
    
    // 初始化位置
    initFloatingPosition();
    
    // 窗口大小改变时，确保悬浮球在视口内
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        // 确保悬浮球在视口内
        const rect = floatingAiChat.getBoundingClientRect();
        const maxX = window.innerWidth - floatingAiChat.offsetWidth;
        const maxY = window.innerHeight - floatingAiChat.offsetHeight;
        
        if (rect.left < 0 || rect.top < 0 || 
            rect.right > window.innerWidth || rect.bottom > window.innerHeight) {
          const validX = Math.max(0, Math.min(rect.left, maxX));
          const validY = Math.max(0, Math.min(rect.top, maxY));
          setTranslate(validX, validY, floatingAiChat);
        }
        
        // 如果窗口是打开的，调整窗口位置
        if (floatingAiWindow && floatingAiWindow.classList.contains('active')) {
          adjustWindowPosition(floatingAiWindow, floatingAiChat);
        }
      }, 250);
    });
    
    /**
     * 设置元素位置
     * 支持在屏幕任意位置放置，不限制在四个边
     * @param {number} xPos - X坐标
     * @param {number} yPos - Y坐标
     * @param {HTMLElement} el - 目标元素
     */
    function setTranslate(xPos, yPos, el) {
      // 限制在视口内，但允许在屏幕任意位置（包括中间）
      const maxX = window.innerWidth - el.offsetWidth;
      const maxY = window.innerHeight - el.offsetHeight;
      
      // 确保不超出屏幕边界，但允许在屏幕中间
      xPos = Math.max(0, Math.min(xPos, maxX));
      yPos = Math.max(0, Math.min(yPos, maxY));
      
      // 使用left和top定位，不使用transform（避免与CSS动画冲突）
      el.style.left = xPos + 'px';
      el.style.right = 'auto';
      el.style.top = yPos + 'px';
      el.style.bottom = 'auto';
      el.style.transform = 'none';
    }
    
    /**
     * 调整AI助手窗口位置，确保不超出屏幕
     * @param {HTMLElement} windowEl - 窗口元素
     * @param {HTMLElement} chatEl - 聊天容器元素
     */
    /**
     * 调整AI助手窗口位置，确保不超出屏幕
     * 优化：在拖拽时平滑调整，确保窗口不挡住悬浮球，并保持美观的动画效果
     */
    function adjustWindowPosition(windowEl, chatEl) {
      if (!windowEl || !chatEl) return;
      
      // 使用requestAnimationFrame确保流畅的动画
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const windowRect = windowEl.getBoundingClientRect();
          const chatRect = chatEl.getBoundingClientRect();
          const viewportWidth = window.innerWidth;
          const viewportHeight = window.innerHeight;
          const padding = 10; // 边距
          
          // 计算窗口相对于悬浮球的位置
          let newRight = parseFloat(windowEl.style.right) || 0;
          let newBottom = parseFloat(windowEl.style.bottom) || 80;
          let useLeft = false;
          let useTop = false;
          
          // 检查右边界：如果窗口超出右边界，改为左对齐
          if (chatRect.left + windowRect.width > viewportWidth - padding) {
            // 计算窗口应该距离左边界的位置
            const leftPos = Math.max(padding, chatRect.left - windowRect.width);
            if (leftPos >= padding) {
              windowEl.style.left = leftPos + 'px';
              windowEl.style.right = 'auto';
              useLeft = true;
            } else {
              // 如果左侧空间也不够，则调整到右边界
              windowEl.style.right = padding + 'px';
              windowEl.style.left = 'auto';
            }
          } else {
            // 默认右对齐
            windowEl.style.right = '0px';
            windowEl.style.left = 'auto';
          }
          
          // 检查上边界：如果窗口超出上边界，改为下对齐
          // 优化：确保窗口不会挡住悬浮球
          const minBottom = chatRect.height + 20; // 悬浮球高度 + 间距
          if (chatRect.bottom - windowRect.height < padding) {
            // 计算窗口应该距离上边界的位置
            const topPos = chatRect.bottom + padding;
            if (topPos + windowRect.height <= viewportHeight - padding) {
              windowEl.style.top = topPos + 'px';
              windowEl.style.bottom = 'auto';
              useTop = true;
            } else {
              // 如果下方空间也不够，则调整到底部，但确保不挡住悬浮球
              windowEl.style.bottom = Math.max(minBottom, padding) + 'px';
              windowEl.style.top = 'auto';
            }
          } else {
            // 默认上对齐（相对于悬浮球），确保不挡住悬浮球
            windowEl.style.bottom = Math.max(80, minBottom) + 'px';
            windowEl.style.top = 'auto';
          }
          
          // 最终检查：确保窗口完全在视口内
          const finalRect = windowEl.getBoundingClientRect();
          if (finalRect.left < padding) {
            windowEl.style.left = padding + 'px';
            windowEl.style.right = 'auto';
          }
          if (finalRect.right > viewportWidth - padding) {
            windowEl.style.right = padding + 'px';
            windowEl.style.left = 'auto';
          }
          if (finalRect.top < padding) {
            windowEl.style.top = padding + 'px';
            windowEl.style.bottom = 'auto';
          }
          if (finalRect.bottom > viewportHeight - padding) {
            windowEl.style.bottom = padding + 'px';
            windowEl.style.top = 'auto';
          }
        });
      });
    }
    
    /**
     * 处理鼠标按下事件
     * 支持在整个悬浮球容器上拖拽，不仅仅是按钮
     */
    floatingAiChat.addEventListener('mousedown', (e) => {
      // 如果点击的是窗口，不拖拽
      if (e.target.closest('.floating-ai-window')) return;
      
      // 记录拖拽开始时的鼠标位置
      startX = e.clientX;
      startY = e.clientY;
      
      // 记录拖拽开始时元素的位置
      const rect = floatingAiChat.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      
      hasMoved = false;  // 重置移动标志
      
      // 允许在整个容器上拖拽
      isDragging = true;
      floatingAiBtn.style.cursor = 'grabbing';
      // 不阻止默认行为，让点击事件可以正常触发
    });
    
    /**
     * 处理触摸开始事件
     * 支持在整个悬浮球容器上拖拽，不仅仅是按钮
     */
    floatingAiChat.addEventListener('touchstart', (e) => {
      // 如果点击的是窗口，不拖拽
      if (e.target.closest('.floating-ai-window')) return;
      
      const touch = e.touches[0];
      if (!touch) return;  // 确保触摸点存在
      
      // 记录拖拽开始时的触摸位置
      startX = touch.clientX;
      startY = touch.clientY;
      
      // 记录拖拽开始时元素的位置
      const rect = floatingAiChat.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      
      hasMoved = false;  // 重置移动标志
      
      // 允许在整个容器上拖拽
      isDragging = true;
      // 不阻止默认行为，让点击事件可以正常触发
    }, { passive: true });  // 使用被动监听，提高性能
    
    /**
     * 更新拖拽位置
     * 重构：直接跟手或跟鼠标拖动，实时响应，无需阈值判断
     */
    function updateDragPosition(clientX, clientY) {
      if (!isDragging) return;
      
      // 取消之前的动画帧
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
      
      // 使用requestAnimationFrame优化性能
      animationFrameId = requestAnimationFrame(() => {
        // 计算移动距离
        const deltaX = clientX - startX;
        const deltaY = clientY - startY;
        
        // 计算新位置：初始位置 + 移动距离
        const newX = startLeft + deltaX;
        const newY = startTop + deltaY;
        
        // 设置位置，允许在屏幕任意位置（包括中间）
        setTranslate(newX, newY, floatingAiChat);
        
        // 如果窗口是打开的，在拖拽时也调整窗口位置
        if (floatingAiWindow && floatingAiWindow.classList.contains('active')) {
          // 使用requestAnimationFrame优化性能，确保流畅的动画
          if (!window.dragAdjustTimer) {
            window.dragAdjustTimer = requestAnimationFrame(() => {
              adjustWindowPosition(floatingAiWindow, floatingAiChat);
              window.dragAdjustTimer = null;
            });
          }
        }
      });
    }
    
    /**
     * 处理鼠标移动事件
     * 重构：直接跟鼠标拖动，实时响应
     */
    document.addEventListener('mousemove', (e) => {
      if (isDragging) {
        // 计算移动距离（用于判断是否移动）
        const deltaX = Math.abs(e.clientX - startX);
        const deltaY = Math.abs(e.clientY - startY);
        
        // 如果移动距离超过阈值，标记为已移动
        if (deltaX > DRAG_THRESHOLD || deltaY > DRAG_THRESHOLD) {
          if (!hasMoved) {
            hasMoved = true;  // 标记为已移动
          }
          e.preventDefault();  // 只有确认是拖拽时才阻止默认行为
        }
        
        // 直接更新位置，实时跟手
        updateDragPosition(e.clientX, e.clientY);
      }
    });
    
    /**
     * 处理触摸移动事件
     * 重构：直接跟手指拖动，实时响应，支持手机平板
     */
    document.addEventListener('touchmove', (e) => {
      if (isDragging) {
        const touch = e.touches[0];
        if (!touch) return;  // 确保触摸点存在
        
        // 计算移动距离（用于判断是否移动）
        const deltaX = Math.abs(touch.clientX - startX);
        const deltaY = Math.abs(touch.clientY - startY);
        
        // 如果移动距离超过阈值，标记为已移动
        if (deltaX > DRAG_THRESHOLD || deltaY > DRAG_THRESHOLD) {
          if (!hasMoved) {
            hasMoved = true;  // 标记为已移动
          }
          e.preventDefault();  // 只有确认是拖拽时才阻止默认行为
          e.stopPropagation();  // 阻止事件冒泡
        }
        
        // 直接更新位置，实时跟手
        updateDragPosition(touch.clientX, touch.clientY);
      }
    }, { passive: false });  // 设置为非被动监听，确保可以阻止默认行为
    
    /**
     * 处理点击/切换窗口显示
     * 支持点击悬浮球打开/关闭窗口
     */
    function toggleFloatingWindow() {
      if (!floatingAiWindow) return;
      
      const isActive = floatingAiWindow.classList.contains('active');
      
      if (isActive) {
        // 关闭窗口
        floatingAiWindow.classList.remove('active');
      } else {
        // 打开窗口
        floatingAiWindow.classList.add('active');
        // 打开窗口时，更新预设问题
        updateFloatingPresetQuestions();
        // 调整窗口位置，确保不超出屏幕（延迟执行，确保窗口已渲染）
        setTimeout(() => {
          adjustWindowPosition(floatingAiWindow, floatingAiChat);
        }, 50);
        // 再次调整，确保位置正确
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            adjustWindowPosition(floatingAiWindow, floatingAiChat);
          });
        });
      }
    }
    
    /**
     * 处理鼠标释放事件
     */
    document.addEventListener('mouseup', (e) => {
      if (isDragging) {
        isDragging = false;
        floatingAiBtn.style.cursor = 'pointer';
        
        // 取消动画帧
        if (animationFrameId) {
          cancelAnimationFrame(animationFrameId);
          animationFrameId = null;
        }
        
        // 如果没有移动，触发点击事件
        if (!hasMoved) {
          // 直接处理点击逻辑，切换窗口显示
          toggleFloatingWindow();
        } else {
          // 如果发生了拖拽，保存位置
          const rect = floatingAiChat.getBoundingClientRect();
          const position = {
            left: rect.left + 'px',
            top: rect.top + 'px'
          };
          localStorage.setItem('floatingAiPosition', JSON.stringify(position));
          
          // 如果窗口是打开的，调整窗口位置
          if (floatingAiWindow && floatingAiWindow.classList.contains('active')) {
            adjustWindowPosition(floatingAiWindow, floatingAiChat);
          }
        }
        
        // 重置标志
        hasMoved = false;
      }
    });
    
    /**
     * 处理触摸结束事件
     * 修复：确保触摸结束事件正确响应，支持手机平板
     */
    document.addEventListener('touchend', (e) => {
      if (isDragging) {
        isDragging = false;
        
        // 取消动画帧
        if (animationFrameId) {
          cancelAnimationFrame(animationFrameId);
          animationFrameId = null;
        }
        
        // 如果没有移动，触发点击事件
        if (!hasMoved) {
          // 直接处理点击逻辑，切换窗口显示
          toggleFloatingWindow();
        } else {
          // 如果发生了拖拽，保存位置
          const rect = floatingAiChat.getBoundingClientRect();
          const position = {
            left: rect.left + 'px',
            top: rect.top + 'px'
          };
          localStorage.setItem('floatingAiPosition', JSON.stringify(position));
          
          // 如果窗口是打开的，调整窗口位置
          if (floatingAiWindow && floatingAiWindow.classList.contains('active')) {
            adjustWindowPosition(floatingAiWindow, floatingAiChat);
          }
        }
        
        // 重置标志
        hasMoved = false;
      }
    }, { passive: true });  // 使用被动监听，提高性能
    
    /**
     * 处理点击事件（作为备用方案）
     * 如果mouseup/touchend没有处理，则通过click事件处理
     * 支持在整个容器上点击，不仅仅是按钮
     */
    floatingAiChat.addEventListener('click', (e) => {
      // 如果点击的是窗口，不处理
      if (e.target.closest('.floating-ai-window')) return;
      
      // 如果已经通过mouseup/touchend处理了，则不再处理
      if (isDragging || hasMoved) {
        return;
      }
      
      // 切换窗口显示状态
      toggleFloatingWindow();
    });
    
    // 注意：resize监听器已在initFloatingPosition后添加，这里不再重复添加
  }
  
  if (floatingAiClose) {
    floatingAiClose.addEventListener('click', () => {
      if (floatingAiWindow) {
        floatingAiWindow.classList.remove('active');
      }
    });
  }
  
  // 悬浮AI聊天输入
  const floatingAskBtn = document.getElementById('floating-ask-btn');
  const floatingCustomInput = document.getElementById('floating-custom-input');
  
  // 优化：处理移动端键盘弹出时的窗口位置调整
  if (floatingCustomInput) {
    // 监听输入框获得焦点（键盘弹出）
    floatingCustomInput.addEventListener('focus', () => {
      // 延迟调整，等待键盘动画完成
      setTimeout(() => {
        if (floatingAiWindow && floatingAiWindow.classList.contains('active')) {
          adjustWindowPosition(floatingAiWindow, floatingAiChat);
        }
        // 滚动到输入框位置，确保输入框可见
        if (floatingCustomInput.scrollIntoView) {
          floatingCustomInput.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }, 300);
    });
    
    // 监听输入框失去焦点（键盘收起）
    floatingCustomInput.addEventListener('blur', () => {
      // 键盘收起后，重新调整窗口位置
      setTimeout(() => {
        if (floatingAiWindow && floatingAiWindow.classList.contains('active')) {
          adjustWindowPosition(floatingAiWindow, floatingAiChat);
        }
      }, 300);
    });
    
    // 使用Visual Viewport API（如果支持）来更精确地处理键盘弹出
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', () => {
        if (floatingAiWindow && floatingAiWindow.classList.contains('active')) {
          adjustWindowPosition(floatingAiWindow, floatingAiChat);
        }
      });
    }
  }
  
  if (floatingAskBtn) {
    floatingAskBtn.addEventListener('click', handleFloatingAIQuestion);
  }
  
  // 监听Enter键发送（已在上面处理，这里不再重复）
  if (floatingCustomInput) {
    floatingCustomInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleFloatingAIQuestion();
      }
    });
  }
  
  // ==================== Footer按钮事件处理 ====================
  /**
   * 使用事件委托处理Footer按钮点击事件
   * 支持许可证页面和关于项目页面的导航
   */
  document.body.addEventListener('click', (e) => {
    const licenseBtn = e.target.closest('.footer-link.license-link, #license-btn');
    const aboutBtn = e.target.closest('.footer-link.about-link, #about-btn');
    
    // 处理许可证按钮点击
    if (licenseBtn) {
      e.preventDefault();
      e.stopPropagation();
      
      // 检查是否已经在许可证页面
      const currentPage = document.querySelector('.page.active');
      if (!currentPage) return;
      const currentPageId = currentPage.id;
      // 如果已经在许可证页面，则返回到上一页
      if (currentPageId === 'license-page') {
        const previousPage = AppState.previousPage || 'init-page';
        navigateToPage(previousPage, 'license-page');
      } else {
        // 否则跳转到许可证页面
        AppState.previousPage = currentPageId;
        navigateToPage('license-page', currentPageId);
      }
    }
    
    // 处理关于项目按钮点击
    if (aboutBtn) {
      e.preventDefault();
      e.stopPropagation();
      
      // 检查是否已经在关于项目页面
      const currentPage = document.querySelector('.page.active');
      if (!currentPage) return;
      const currentPageId = currentPage.id;
      // 如果已经在关于项目页面，则返回到上一页
      if (currentPageId === 'about-page') {
        const previousPage = AppState.previousPage || 'init-page';
        navigateToPage(previousPage, 'about-page');
      } else {
        // 否则跳转到关于项目页面
        AppState.previousPage = currentPageId;
        navigateToPage('about-page', currentPageId);
      }
    }
  });
  
  // ==================== 关于项目页面返回按钮 ====================
  /**
   * 处理关于项目页面的返回按钮点击事件
   */
  const aboutBackBtn = document.getElementById('about-back-btn');
  if (aboutBackBtn) {
    aboutBackBtn.addEventListener('click', () => {
      const previousPage = AppState.previousPage || 'init-page';
      navigateToPage(previousPage, 'about-page');
    });
  }
}

// ==================== 信标选择渲染（优化：使用后端筛选的数据）====================
async function renderBeaconChips() {
  const container = document.getElementById('beacon-chips');
  if (!container) return;
  
  // 优化：使用后端API，后端已处理筛选、映射和排序
  const espC3Beacons = await loadESPC3Beacons();
  
  // 保存当前显示的信标MAC地址，用于动画（排除提示文本和正在删除的）
  const currentMacs = new Set(
    Array.from(container.children)
      .filter(el => el.dataset.mac && !el.classList.contains('beacon-chip-removing'))
      .map(el => el.dataset.mac)
  );
  
  // 处理空列表情况
  if (espC3Beacons.length === 0) {
    // 如果有现有元素，先删除它们（带动画）
    const existingChips = Array.from(container.children).filter(el => 
      el.dataset.mac && !el.classList.contains('beacon-chip-removing')
    );
    
    if (existingChips.length > 0) {
      existingChips.forEach((el, index) => {
      // 使用requestAnimationFrame优化动画触发，使用transition替代animation
      requestAnimationFrame(() => {
        setTimeout(() => {
          el.classList.add('beacon-chip-removing');
          el.style.pointerEvents = 'none';
          
          // 延迟删除，确保transition完成
          setTimeout(() => {
            if (el.parentNode && el.dataset.mac) {
              el.remove();
            }
          }, 500); // transition持续时间
        }, index * 50); // 错开删除时间，避免同时删除
      });
      });
      
      // 等待所有删除动画完成后显示提示
      setTimeout(() => {
        const remainingChips = Array.from(container.children).filter(el => el.dataset.mac);
        if (remainingChips.length === 0) {
          const emptyMsg = container.querySelector('p');
          if (!emptyMsg || !emptyMsg.textContent.includes('暂无')) {
            const emptyDiv = document.createElement('p');
            emptyDiv.style.cssText = 'text-align:center;color:var(--text-light);grid-column:1/-1;padding:20px;animation:fadeIn 0.4s ease;';
            emptyDiv.textContent = '暂无ESP-C3信标';
            container.appendChild(emptyDiv);
          }
        }
      }, existingChips.length * 50 + 600);
    } else {
      // 如果没有现有元素，直接显示提示
      const emptyMsg = container.querySelector('p');
      if (!emptyMsg || !emptyMsg.textContent.includes('暂无')) {
        const emptyDiv = document.createElement('p');
        emptyDiv.style.cssText = 'text-align:center;color:var(--text-light);grid-column:1/-1;padding:20px;animation:fadeIn 0.4s ease;';
        emptyDiv.textContent = '暂无ESP-C3信标';
        container.appendChild(emptyDiv);
      }
    }
    return;
  }
  
  // 移除"暂无信标"提示文本（如果存在）
  const emptyMessage = container.querySelector('p');
  if (emptyMessage && emptyMessage.textContent.includes('暂无')) {
    emptyMessage.style.animation = 'fadeOut 0.4s ease forwards';
    setTimeout(() => {
      if (emptyMessage.parentNode) {
        emptyMessage.remove();
      }
    }, 400);
  }
  
  // 优化：后端返回的是数组，每个元素包含mac、name、displayName等
  const newMacs = new Set(espC3Beacons.map(beacon => beacon.mac));
  
  // 找出需要删除的信标（只删除真正不在新列表中的）
  const toRemove = Array.from(container.children).filter(el => {
    const mac = el.dataset.mac;
    if (!mac) return false; // 跳过非信标元素
    if (el.classList.contains('beacon-chip-removing')) return false; // 跳过正在删除的
    return !newMacs.has(mac);
  });
  
  // 找出需要添加的信标
  const toAdd = espC3Beacons.filter(beacon => !currentMacs.has(beacon.mac));
  
  // 找出需要更新的信标（保留现有元素，只更新数据）
  const toUpdate = espC3Beacons.filter(beacon => currentMacs.has(beacon.mac));
  
  // 删除不再存在的信标（使用平滑动画）
  toRemove.forEach((el, index) => {
    const mac = el.dataset.mac;
    if (!mac) return;
    
    // 再次确认该信标不在新列表中
    if (newMacs.has(mac)) return;
    
    // 使用requestAnimationFrame优化动画触发，使用transition替代animation
    requestAnimationFrame(() => {
      setTimeout(() => {
        el.classList.add('beacon-chip-removing');
        el.style.pointerEvents = 'none';
        
        // 延迟删除，确保transition完成
        setTimeout(() => {
          if (el.parentNode && el.dataset.mac === mac) {
            // 再次确认该信标不在新列表中
            if (!newMacs.has(mac)) {
              el.remove();
            } else {
              // 如果又出现在新列表中，取消删除
              el.classList.remove('beacon-chip-removing');
              el.style.pointerEvents = '';
            }
          }
        }, 500); // transition持续时间
      }, index * 50); // 错开删除时间
    });
  });
  
  // 优化：后端已处理名称映射，直接使用displayName
  // 更新现有信标（如果有名称变化）
  toUpdate.forEach(beacon => {
    const existingChip = Array.from(container.children).find(el => 
      el.dataset.mac === beacon.mac && !el.classList.contains('beacon-chip-removing')
    );
    if (existingChip) {
      const span = existingChip.querySelector('span');
      const newName = beacon.displayName || beacon.name;
      if (span && span.textContent !== newName) {
        span.textContent = newName;
      }
    }
  });
  
  // 添加新信标（使用平滑动画）
  toAdd.forEach((beacon, index) => {
    // 检查是否已经有该信标（防止重复添加）
    const existingChip = Array.from(container.children).find(el => 
      el.dataset.mac === beacon.mac && !el.classList.contains('beacon-chip-removing')
    );
    if (existingChip) {
      return; // 如果已存在，跳过
    }
    
    const chip = document.createElement('button');
    chip.className = 'beacon-chip beacon-chip-entering';
    chip.dataset.mac = beacon.mac;
    // 优化：使用后端返回的displayName
    chip.innerHTML = `<span>${beacon.displayName || beacon.name}</span>`;
    chip.addEventListener('click', () => selectBeacon(beacon.name, beacon.mac));
    chip.style.pointerEvents = 'none'; // 动画期间禁用交互
    
    // 先添加到DOM
    container.appendChild(chip);
    
    // 使用requestAnimationFrame优化动画触发，使用transition替代animation
    requestAnimationFrame(() => {
      chip.classList.add('animate');
      setTimeout(() => {
        chip.classList.remove('beacon-chip-entering', 'animate');
        chip.style.pointerEvents = ''; // 动画完成后启用交互
      }, 500); // transition持续时间
    });
  });
}

// ==================== 信标选择处理 ====================
async function selectBeacon(beaconName, beaconMac) {
  AppState.currentBeaconId = beaconName;
  AppState.currentBeaconMac = beaconMac;
  
  // 重置稳定性检测状态（切换信标时重置）
  AppState.lastValidReceiverCount = 0;
  AppState.emptyCount = 0;
  
  // 跳转到列表页
  navigateToPage('list-page', 'init-page');
  
  // 渲染展区列表（async函数，使用后端API）
  await renderExhibitionList();
  
  // 启动定时更新
  startUpdateTimer();
}

// ==================== 展区列表渲染（优化：使用后端API，只处理当前信标）====================
// 优化后的展区列表渲染逻辑：实时检测、平滑动画、准确排序、FLIP技术
async function renderExhibitionList() {
  const grid = document.getElementById('exhibition-grid');
  const titleEl = document.getElementById('beacon-title');
  const timeEl = document.getElementById('update-time');
  const totalEl = document.getElementById('total-exhibitions');
  
  if (!grid) return;
  
  // 优化：使用后端API，只加载当前信标的数据
  if (!AppState.currentBeaconMac) {
    // 如果没有MAC地址，显示提示
    const existingEmptyMsg = grid.querySelector('div[style*="grid-column"]');
    if (!existingEmptyMsg || !existingEmptyMsg.textContent.includes('暂无接收器信息')) {
      grid.innerHTML = `
        <div style="grid-column: 1/-1; text-align: center; padding: 40px 20px; animation: fadeIn 0.4s ease;">
          <svg viewBox="0 0 24 24" fill="currentColor" style="width: 48px; height: 48px; margin-bottom: 16px; color: var(--text-light);">
            <path d="M9.5,3A6.5,6.5 0 0,1 16,9.5C16,11.11 15.41,12.59 14.44,13.73L14.71,14H15.5L20.5,19L19,20.5L14,15.5V14.71L13.73,14.44C12.59,15.41 11.11,16 9.5,16A6.5,6.5 0 0,1 3,9.5A6.5,6.5 0 0,1 9.5,3M9.5,5C7,5 5,7 5,9.5C5,12 7,14 9.5,14C12,14 14,12 14,9.5C14,7 12,5 9.5,5Z"/>
          </svg>
          <p style="font-size: 16px; color: var(--text-secondary); margin-bottom: 8px;">该信标暂无接收器信息</p>
          <p style="font-size: 14px; color: var(--text-light);">请等待接收器检测到信标信号</p>
        </div>
      `;
    }
    if (totalEl) totalEl.textContent = '0';
    return;
  }
  
  // 优化：使用后端API加载当前信标的接收器列表（后端已处理筛选、排序和映射）
  const beaconData = await loadBeaconReceivers(AppState.currentBeaconMac);
  
  // 更新标题（使用后端返回的displayName）
  if (titleEl) {
    titleEl.textContent = beaconData.displayName || AppState.currentBeaconId || '未知信标';
  }
  
  // 更新时间
  if (timeEl) {
    timeEl.textContent = `更新于：${new Date().toLocaleTimeString('zh-CN')}`;
  }
  
  // 优化：后端已处理筛选和排序，直接使用
  const receivers = beaconData.receivers || [];
  
  // 过滤：确保展区数据存在
  const validReceivers = receivers.filter(receiver => {
    return AppState.exhibitions && AppState.exhibitions[receiver.receiverId];
  });
  
  // 优化：检测稳定性逻辑 - 防止突然从有数据变为0（可能是检测不稳定）
  const currentValidCount = validReceivers.length;
  const lastValidCount = AppState.lastValidReceiverCount || 0;
  const hasExistingCards = Array.from(grid.children).some(el => 
    el.dataset.receiverId && !el.classList.contains('card-removing')
  );
  
  if (currentValidCount === 0 && lastValidCount > 0 && hasExistingCards) {
    AppState.emptyCount = (AppState.emptyCount || 0) + 1;
    if (AppState.emptyCount >= 3) {
      AppState.emptyCount = 0;
      AppState.lastValidReceiverCount = 0;
      // 继续执行下面的空状态显示逻辑
    } else {
      // 保持当前显示，不更新页面
      return;
    }
  } else {
    // 如果有数据，重置空计数
    if (currentValidCount > 0) {
      AppState.emptyCount = 0;
      AppState.lastValidReceiverCount = currentValidCount;
    } else if (currentValidCount === 0 && lastValidCount === 0) {
      // 如果一直是0，增加空计数
      AppState.emptyCount = (AppState.emptyCount || 0) + 1;
    }
  }
  
  // 如果过滤后没有有效接收器，显示提示
  if (validReceivers.length === 0) {
    // 检查是否有正在删除的卡片
    const hasRemovingCards = Array.from(grid.children).some(el => 
      el.classList.contains('card-removing')
    );
    
    // 如果没有正在删除的卡片，才显示空状态
    if (!hasRemovingCards) {
      const existingEmptyMsg = grid.querySelector('div[style*="grid-column"]');
      if (!existingEmptyMsg || !existingEmptyMsg.textContent.includes('暂无接收器检测')) {
        grid.innerHTML = `
          <div style="grid-column: 1/-1; text-align: center; padding: 40px 20px; animation: fadeIn 0.4s ease;">
            <svg viewBox="0 0 24 24" fill="currentColor" style="width: 48px; height: 48px; margin-bottom: 16px; color: var(--text-light);">
              <path d="M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,4C16.41,4 20,7.59 20,12C20,16.41 16.41,20 12,20C7.59,20 4,16.41 4,12C4,7.59 7.59,4 12,4M12,6A6,6 0 0,0 6,12A6,6 0 0,0 12,18A6,6 0 0,0 18,12A6,6 0 0,0 12,6M12,8A4,4 0 0,1 16,12A4,4 0 0,1 12,16A4,4 0 0,1 8,12A4,4 0 0,1 12,8M12,10A2,2 0 0,0 10,12A2,2 0 0,0 12,14A2,2 0 0,0 14,12A2,2 0 0,0 12,10Z"/>
            </svg>
            <p style="font-size: 16px; color: var(--text-secondary); margin-bottom: 8px;">暂无接收器检测到此信标</p>
            <p style="font-size: 14px; color: var(--text-light);">请等待接收器检测到信标信号</p>
          </div>
        `;
      }
    }
    if (totalEl) totalEl.textContent = '0';
    // 更新最后有效数量
    AppState.lastValidReceiverCount = 0;
    return;
  }
  
  // 更新最后有效数量
  AppState.lastValidReceiverCount = validReceivers.length;
  
  // 移除空状态提示（如果存在）
  const emptyMsg = grid.querySelector('div[style*="grid-column"]');
  if (emptyMsg && (emptyMsg.textContent.includes('暂无接收器') || emptyMsg.textContent.includes('暂无接收器信息'))) {
    emptyMsg.style.animation = 'fadeOut 0.3s ease forwards';
    setTimeout(() => {
      if (emptyMsg.parentNode) {
        emptyMsg.remove();
      }
    }, 300);
  }
  
  // 保存当前显示的接收器ID，用于动画
  const currentReceiverIds = new Set(
    Array.from(grid.children)
      .filter(el => el.dataset.receiverId && !el.classList.contains('card-removing'))
      .map(el => el.dataset.receiverId)
  );
  
  const newReceiverIds = new Set(validReceivers.map(r => r.receiverId));
  
  // 找出需要删除的卡片（只删除真正不在新列表中的）
  const toRemove = Array.from(grid.children).filter(el => {
    const receiverId = el.dataset.receiverId;
    if (!receiverId) return false; // 跳过非卡片元素
    if (el.classList.contains('card-removing')) return false; // 跳过正在删除的卡片
    
    // 检查该接收器是否真的不在新列表中
    const stillExists = newReceiverIds.has(receiverId);
    return !stillExists;
  });
  
  // 找出需要添加的接收器
  const toAdd = validReceivers.filter(r => !currentReceiverIds.has(r.receiverId));
  
  // 删除不再存在的卡片（使用平滑动画）
  toRemove.forEach((el, index) => {
    const receiverId = el.dataset.receiverId;
    if (!receiverId) return;
    
    // 再次确认该接收器不在新列表中
    if (newReceiverIds.has(receiverId)) return;
    
    // 添加删除动画（使用transition）
    el.classList.add('card-removing');
    el.style.pointerEvents = 'none';
    
    // 延迟删除，确保transition完成
    setTimeout(() => {
      // 再次确认该元素仍然需要删除
      if (el.parentNode && el.dataset.receiverId === receiverId) {
        if (!newReceiverIds.has(receiverId)) {
          el.remove();
        } else {
          // 如果又出现在新列表中，取消删除
          el.classList.remove('card-removing');
          el.style.pointerEvents = '';
        }
      }
    }, 500); // transition持续时间
  });
  
  // 优化：使用FLIP技术实现平滑排序
  // FLIP: First, Last, Invert, Play
  const existingCards = Array.from(grid.children)
    .filter(el => el.dataset.receiverId && !el.classList.contains('card-removing'))
    .map(el => ({
      element: el,
      receiverId: el.dataset.receiverId
    }));
  
  // First: 记录初始位置
  const firstPositions = new Map();
  existingCards.forEach(({ element, receiverId }) => {
    const rect = element.getBoundingClientRect();
    firstPositions.set(receiverId, {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height
    });
  });
  
  // 更新现有卡片：信号强度、在线状态、位置
  validReceivers.forEach((receiver, newIndex) => {
    const existingCardData = existingCards.find(data => data.receiverId === receiver.receiverId);
    if (existingCardData) {
      const existingCard = existingCardData.element;
      
      // 更新信号强度显示
      updateCardSignalInfo(existingCard, receiver);
      
      // 更新在线状态
      const badge = existingCard.querySelector('.card-badge');
      if (badge) {
        const isOnline = receiver.online;
        badge.className = `card-badge ${isOnline ? 'online' : 'offline'}`;
        badge.textContent = isOnline ? '在线' : '离线';
      }
      
      // Last: 更新order，让浏览器计算新位置
      const currentOrder = parseInt(existingCard.style.order) || 0;
      if (currentOrder !== newIndex) {
        existingCard.style.order = newIndex;
        
        // 使用requestAnimationFrame确保DOM更新
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            // Invert: 计算位置差，使用transform移动到原位置
            const firstPos = firstPositions.get(receiver.receiverId);
            if (firstPos) {
              const newRect = existingCard.getBoundingClientRect();
              const deltaX = firstPos.x - newRect.left;
              const deltaY = firstPos.y - newRect.top;
              
              // 如果位置变化很小，直接使用order过渡
              if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) {
                existingCard.classList.add('card-moving');
                setTimeout(() => {
                  existingCard.classList.remove('card-moving');
                }, 500);
                return;
              }
              
              // 应用transform，使元素看起来还在原位置
              existingCard.style.transition = 'none';
              existingCard.style.transform = `translate(${deltaX}px, ${deltaY}px) translateZ(0)`;
              existingCard.style.willChange = 'transform';
              
              // Play: 移除transform，让元素平滑移动到新位置
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  existingCard.style.transition = '';
                  existingCard.style.transform = 'translateZ(0)';
                  existingCard.classList.add('card-moving');
                  
                  // 动画完成后清理
                  setTimeout(() => {
                    existingCard.classList.remove('card-moving');
                    existingCard.style.willChange = '';
                  }, 500);
                });
              });
            } else {
              // 如果没有旧位置，直接使用order过渡
              existingCard.classList.add('card-moving');
              setTimeout(() => {
                existingCard.classList.remove('card-moving');
              }, 500);
            }
          });
        });
      }
    }
  });
  
  // 添加新卡片（使用平滑动画）
  toAdd.forEach((receiver, index) => {
    // 确保接收器不在删除列表中
    const exhibition = AppState.exhibitions[receiver.receiverId];
    if (!exhibition) {
      return;
    }
    
    // 再次检查是否已经有该卡片（防止重复添加）
    const existingCard = Array.from(grid.children).find(
      el => el.dataset.receiverId === receiver.receiverId && !el.classList.contains('card-removing')
    );
    if (existingCard) {
      return;
    }
    
    const card = createExhibitionCard(receiver.receiverId, exhibition, receiver);
    const targetIndex = validReceivers.findIndex(r => r.receiverId === receiver.receiverId);
    card.style.order = targetIndex;
    card.classList.add('card-entering');
    grid.appendChild(card);
    
    // 触发进入动画（使用transition替代animation）
    requestAnimationFrame(() => {
      card.classList.add('animate');
      setTimeout(() => {
        card.classList.remove('card-entering', 'animate');
      }, 500); // transition持续时间
    });
  });
  
  // 更新总数
  if (totalEl) totalEl.textContent = validReceivers.length.toString();
}

// ==================== 创建展区卡片 ====================
function createExhibitionCard(receiverId, exhibition, receiverInfo = null) {
  const card = document.createElement('div');
  card.className = 'exhibition-card';
  card.dataset.receiverId = receiverId;
  
  // 判断在线状态
  const isOnline = receiverInfo ? receiverInfo.online : isReceiverOnline(receiverId);
  const rssi = receiverInfo ? receiverInfo.rssi : null;
  const signalStrength = getSignalStrengthText(rssi);
  
  card.innerHTML = `
    ${exhibition.thumbnail ? 
      `<div class="card-thumbnail"><img src="${exhibition.thumbnail}" alt="${exhibition.name}"></div>` :
      `<div class="card-thumbnail"><div class="card-placeholder"></div></div>`
    }
    <div class="card-content">
      <div class="card-header">
        <h3 class="card-title">${exhibition.name}</h3>
        <span class="card-badge ${isOnline ? 'online' : 'offline'}">
          ${isOnline ? '在线' : '离线'}
        </span>
      </div>
      <p class="card-description">${exhibition.description || '暂无描述'}</p>
      <div class="card-meta">
        <div class="meta-item">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M12,2C8.13,2 5,5.13 5,9C5,14.25 12,22 12,22C12,22 19,14.25 19,9C19,5.13 15.87,2 12,2M12,11.5A2.5,2.5 0 0,1 9.5,9A2.5,2.5 0 0,1 12,6.5A2.5,2.5 0 0,1 14.5,9A2.5,2.5 0 0,1 12,11.5Z"/>
          </svg>
          <span>${receiverId}</span>
        </div>
        ${rssi !== null ? `
        <div class="meta-item signal-item" data-rssi="${rssi}">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4A8,8 0 0,1 20,12A8,8 0 0,1 12,20M12,6A6,6 0 0,0 6,12A6,6 0 0,0 12,18A6,6 0 0,0 18,12A6,6 0 0,0 12,6M12,16A4,4 0 0,1 8,12A4,4 0 0,1 12,8A4,4 0 0,1 16,12A4,4 0 0,1 12,16Z"/>
          </svg>
          <span class="signal-text">${signalStrength}</span>
          <span class="rssi-text">${rssi}dBm</span>
        </div>
        ` : `
        <div class="meta-item">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4A8,8 0 0,1 20,12A8,8 0 0,1 12,20M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12.5,7V12.25L17,14.92L16.25,16.15L11,13V7H12.5Z"/>
          </svg>
          <span>实时更新</span>
        </div>
        `}
      </div>
    </div>
  `;
  
  // 点击事件
  card.addEventListener('click', () => {
    AppState.currentExhibitionId = receiverId;
    AppState.currentReceiverId = receiverId;
    navigateToPage('detail-page', 'list-page');
    renderExhibitionDetail(receiverId, exhibition);
  });
  
  return card;
}

// ==================== 更新卡片信号信息 ====================
function updateCardSignalInfo(card, receiver) {
  const signalItem = card.querySelector('.signal-item');
  if (!signalItem) return;
  
  const signalText = signalItem.querySelector('.signal-text');
  const rssiText = signalItem.querySelector('.rssi-text');
  
  if (signalText && rssiText) {
    const oldRssi = parseInt(signalItem.dataset.rssi) || -100;
    const newRssi = receiver.rssi;
    
    // 如果信号强度变化，添加更新动画
    if (oldRssi !== newRssi) {
      signalItem.classList.add('signal-updating');
      setTimeout(() => {
        signalItem.classList.remove('signal-updating');
      }, 300);
    }
    
    signalItem.dataset.rssi = newRssi;
    signalText.textContent = getSignalStrengthText(newRssi);
    rssiText.textContent = `${newRssi}dBm`;
  }
}

// ==================== 获取信号强度文本 ====================
function getSignalStrengthText(rssi) {
  if (rssi >= -50) return '强';
  if (rssi >= -70) return '中';
  if (rssi >= -90) return '弱';
  return '极弱';
}

// ==================== 判断接收器是否在线 ====================
function isReceiverOnline(receiverId) {
  const device = AppState.bleData?.devices?.[receiverId];
  if (!device) return false;
  
  const now = Date.now();
  const lastUpdate = device.update || 0;
  const ACTIVE_WINDOW = 10000; // 10秒
  
  return (now - lastUpdate) <= ACTIVE_WINDOW;
}

// ==================== 展区详情渲染 ====================
async function renderExhibitionDetail(receiverId, exhibition) {
  const nameEl = document.getElementById('detail-exhibition-name');
  const timeEl = document.getElementById('detail-update-time');
  const contentEl = document.getElementById('detail-content');
  
  if (nameEl) {
    nameEl.textContent = exhibition.name;
  }
  
  if (timeEl) {
    timeEl.textContent = `更新于：${new Date().toLocaleTimeString('zh-CN')}`;
  }
  
  // 加载详情内容
  if (contentEl && exhibition.contentFile) {
    try {
      const response = await fetch(`data/${exhibition.contentFile}`);
      const html = await response.text();
      contentEl.innerHTML = html;
    } catch (error) {
      contentEl.innerHTML = `
        <div style="padding: 40px 20px; text-align: center;">
          <p style="color: var(--text-secondary);">加载详情失败</p>
        </div>
      `;
    }
  } else {
    contentEl.innerHTML = `
      <div style="padding: 40px 20px; text-align: center;">
        <p style="color: var(--text-secondary);">暂无详细内容</p>
      </div>
    `;
  }
  
  // 渲染预设问题
  renderPresetQuestions(exhibition.aiQuestions);
  
  // 清空之前的回答
  clearAIAnswer();
}

// ==================== 渲染预设问题 ====================
function renderPresetQuestions(customQuestions) {
  const container = document.getElementById('preset-questions');
  if (!container) return;
  
  container.innerHTML = '';
  
  // 优先使用展区自定义问题，否则使用全局预设
  const questions = customQuestions && customQuestions.length > 0 
    ? customQuestions 
    : (AppState.aiPrompts?.prompts || []).slice(0, 4);
  
  if (questions.length === 0) {
    return;
  }
  
  questions.forEach(question => {
    const btn = document.createElement('button');
    btn.className = 'preset-btn';
    btn.textContent = question;
    btn.addEventListener('click', () => {
      document.getElementById('custom-input').value = question;
      handleAIQuestion();
    });
    container.appendChild(btn);
  });
}

// ==================== AI问答处理 ====================
async function handleAIQuestion() {
  const input = document.getElementById('custom-input');
  const askBtn = document.getElementById('ask-btn');
  const question = input.value.trim();
  if (!question) {
    alert('请输入问题');
    return;
  }
  input.disabled = true;
  askBtn.disabled = true;
  showAILoading();
  try {
    const { ok, data, message } = await apiPost(API.AI_CHAT, {
      question,
      receiverId: AppState.currentReceiverId,
      beaconId: AppState.currentBeaconId
    });
    const answer = (ok && data && data.answer) ? data.answer : (message || '抱歉，无法获取回答，请稍后重试。');
    displayAIAnswer(answer);
  } catch (error) {
    displayAIAnswer('抱歉，服务暂时不可用，请稍后重试。');
  } finally {
    input.disabled = false;
    askBtn.disabled = false;
    input.value = '';
  }
}

// ==================== 显示AI加载状态 ====================
function showAILoading() {
  const container = document.getElementById('ai-answer-container');
  if (!container) return;
  
  container.innerHTML = `
    <div class="answer-loading">
      <span>AI正在思考</span>
      <span class="loading-dots"></span>
    </div>
  `;
}

// ==================== 显示AI回答 ====================
/**
 * 显示AI回答（带打字机效果）
 * 格式化并显示AI的回答内容，使用打字机效果逐字显示
 * @param {string} answer - AI回答的文本内容
 */
function displayAIAnswer(answer) {
  const container = document.getElementById('ai-answer-container');
  if (!container) return;
  
  // 简单的Markdown渲染
  const formattedAnswer = formatMarkdown(answer);
  
  // 先显示结构，内容区域留空
  container.innerHTML = `
    <div class="ai-answer">
      <div class="answer-header">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M21,16.5C21,16.88 20.79,17.21 20.47,17.38L12.57,21.82C12.41,21.94 12.21,22 12,22C11.79,22 11.59,21.94 11.43,21.82L3.53,17.38C3.21,17.21 3,16.88 3,16.5V7.5C3,7.12 3.21,6.79 3.53,6.62L11.43,2.18C11.59,2.06 11.79,2 12,2C12.21,2 12.41,2.06 12.57,2.18L20.47,6.62C20.79,6.79 21,7.12 21,7.5V16.5M12,4.15L5,8.09V15.91L12,19.85L19,15.91V8.09L12,4.15Z"/>
        </svg>
        AI助手回答
      </div>
      <div class="answer-content"></div>
    </div>
  `;
  
  const contentDiv = container.querySelector('.answer-content');
  
  // 打字机效果
  let index = 0;
  const speed = 20; // 打字速度（毫秒/字符）
  
  function typeWriter() {
    if (index < formattedAnswer.length) {
      // 获取当前要显示的文本
      const currentText = formattedAnswer.substring(0, index + 1);
      contentDiv.innerHTML = currentText;
      
      // 滚动到回答位置
      container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      
      index++;
      setTimeout(typeWriter, speed);
    }
  }
  
  // 开始打字机效果
  typeWriter();
}

// ==================== 简单Markdown格式化 ====================
function formatMarkdown(text) {
  if (!text) return '';
  
  // 转义HTML
  text = text.replace(/&/g, '&amp;')
             .replace(/</g, '&lt;')
             .replace(/>/g, '&gt;');
  
  // 段落
  text = text.split('\n\n').map(p => `<p>${p}</p>`).join('');
  
  // 加粗
  text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  
  // 斜体
  text = text.replace(/\*(.*?)\*/g, '<em>$1</em>');
  
  // 列表（简单处理）
  text = text.replace(/<p>([•\-\*]\s.*?)<\/p>/g, (match, content) => {
    const items = content.split('\n').map(line => {
      const cleaned = line.replace(/^[•\-\*]\s/, '');
      return `<li>${cleaned}</li>`;
    }).join('');
    return `<ul>${items}</ul>`;
  });
  
  return text;
}

// ==================== 清除AI回答 ====================
function clearAIAnswer() {
  const container = document.getElementById('ai-answer-container');
  if (container) {
    container.innerHTML = '';
  }
  
  const input = document.getElementById('custom-input');
  if (input) {
    input.value = '';
  }
}

// ==================== 页面导航模块 ====================
/**
 * 页面导航函数
 * 处理页面之间的切换，支持前进和后退动画
 * @param {string} targetPageId - 目标页面ID
 * @param {string} currentPageId - 当前页面ID
 */
function navigateToPage(targetPageId, currentPageId) {
  const targetPage = document.getElementById(targetPageId);
  const currentPage = document.getElementById(currentPageId);
  
  if (!targetPage) {
    return;
  }
  
  let actualCurrentPage = currentPage;
  if (!actualCurrentPage) {
    // 如果当前页面不存在，尝试找到活动页面
    const activePage = document.querySelector('.page.active');
    if (activePage) {
      actualCurrentPage = activePage;
    } else {
      // 如果也没有活动页面，直接显示目标页面
      if (targetPageId === 'init-page' || targetPageId === 'easter-egg-page') {
        targetPage.style.display = 'flex';
      } else {
        targetPage.style.display = 'block';
      }
      targetPage.classList.add('active');
      return;
    }
  }
  
  const actualCurrentPageId = actualCurrentPage.id;
  
  // 保存当前页面ID作为previousPage（除了从首页跳转时）
  if (actualCurrentPageId !== 'init-page' || targetPageId !== 'init-page') {
    AppState.previousPage = actualCurrentPageId;
  }
  
  // 判断前进还是后退
  const isBack = targetPageId < actualCurrentPageId || 
                 (actualCurrentPageId === 'detail-page' && targetPageId === 'list-page') ||
                 (actualCurrentPageId === 'list-page' && targetPageId === 'init-page') ||
                 (actualCurrentPageId === 'license-page') ||
                 (actualCurrentPageId === 'about-page');
  
  // 设置目标页面初始位置
  if (isBack) {
    targetPage.style.transform = 'translateX(-100%)';
    actualCurrentPage.classList.add('slide-out-right');
  } else {
    targetPage.style.transform = 'translateX(100%)';
    actualCurrentPage.classList.add('slide-out-left');
  }
  
  // 显示目标页面（但不激活）
  // 首页和彩蛋页面需要使用flex布局，其他页面使用block
  if (targetPageId === 'init-page' || targetPageId === 'easter-egg-page') {
    targetPage.style.display = 'flex';
  } else {
    targetPage.style.display = 'block';
  }
  
  // 强制重排以触发动画
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      // 移除目标页面的初始transform，触发进入动画
      targetPage.style.transform = '';
      targetPage.style.pointerEvents = 'auto';
      actualCurrentPage.style.pointerEvents = 'none';
      targetPage.classList.add('active');
      
      // 等待动画完成后清理
      setTimeout(() => {
        actualCurrentPage.classList.remove('active', 'slide-out-left', 'slide-out-right');
        actualCurrentPage.style.display = 'none';
        actualCurrentPage.style.transform = '';
        actualCurrentPage.style.pointerEvents = 'none';
        targetPage.style.pointerEvents = 'auto';
        // 清理will-change以优化性能
        actualCurrentPage.style.willChange = '';
        targetPage.style.willChange = '';
        
        // 如果是首页，强制重新计算布局以确保footer在底部
        if (targetPageId === 'init-page') {
          // 确保使用flex布局并触发重排
          requestAnimationFrame(() => {
            targetPage.style.display = 'flex';
            // 触发重排以确保flex布局正确计算
            void targetPage.offsetHeight;
            // 再次确保footer在底部
            const footer = targetPage.querySelector('.global-footer');
            if (footer) {
              footer.style.marginTop = 'auto';
            }
          });
        }
        
        // 更新footer按钮的active状态
        const allFooterLinks = document.querySelectorAll('.footer-link');
        allFooterLinks.forEach(link => {
          link.classList.remove('active');
          link.removeAttribute('aria-current');
        });
        
        // 根据当前页面设置active状态
        if (targetPageId === 'license-page') {
          const licenseLink = document.querySelector('.footer-link.license-link');
          if (licenseLink) {
            licenseLink.classList.add('active');
            licenseLink.setAttribute('aria-current', 'page');
          }
        } else if (targetPageId === 'about-page') {
          const aboutLink = document.querySelector('.footer-link.about-link');
          if (aboutLink) {
            aboutLink.classList.add('active');
            aboutLink.setAttribute('aria-current', 'page');
          }
        }
      }, 300);
    });
  });
  
  // 滚动到顶部
  window.scrollTo({ top: 0, behavior: 'smooth' });
  
  if (targetPageId === 'list-page' || targetPageId === 'license-page') {
    requestAnimationFrame(async () => {
      if (targetPageId === 'list-page') {
        await drawVisitorChart('visitor-chart', 'total-visitors');
      } else if (targetPageId === 'license-page') {
        await drawVisitorChart('visitor-chart-license', 'total-visitors-license');
      }
    });
  }
  
  // 粒子效果现在全局显示，不需要在页面切换时启动/停止
  // 粒子效果在所有页面都显示，作为全局背景
}

// ==================== 数据更新定时器模块 ====================
/**
 * 数据更新定时器管理
 * 提供定时更新数据的功能，支持启动、停止和清理
 */

/**
 * 清除更新定时器
 * 停止当前的数据更新定时器
 */
function clearUpdateTimer() {
  if (AppState.updateTimer) {
    clearInterval(AppState.updateTimer);
    AppState.updateTimer = null;
  }
}

/**
 * 更新展区状态
 * 重新渲染展区列表以更新所有信息（包括排序和在线状态）
 */
async function updateExhibitionStatus() {
  // 重新渲染列表以更新所有信息（包括排序）
  await renderExhibitionList();
}

/**
 * 更新头部时间显示
 * 更新页面头部的时间显示
 * @param {string} elementId - 时间元素的ID
 */
function updateHeaderTime(elementId) {
  const timeEl = document.getElementById(elementId);
  if (timeEl) {
    timeEl.textContent = `更新于：${new Date().toLocaleTimeString('zh-CN')}`;
  }
}

// ==================== 加载动画控制模块 ====================
/**
 * 加载动画控制模块
 * 提供全局加载动画的显示和隐藏功能
 */

/**
 * 显示加载动画
 * 在数据加载时显示全局加载动画
 */
function showLoading() {
  const loading = document.getElementById('loading');
  if (loading) {
    loading.style.display = 'flex';
  }
}

/**
 * 隐藏加载动画
 * 数据加载完成后隐藏全局加载动画
 */
function hideLoading() {
  const loading = document.getElementById('loading');
  if (loading) {
    loading.style.display = 'none';
  }
}

// ==================== 参观人数统计图表模块 ====================
/**
 * 参观人数统计图表模块
 * 数据来源：/api/kb/visitor-stats，需在 www/kb/data/visitor-stats.json 配置
 */

/** 参观人数数据缓存（由 loadVisitorStats 填充） */
let visitorStatsCache = [];

/**
 * 从 API 加载参观人数数据
 * @returns {Promise<Array>} 参观人数数据数组
 */
async function loadVisitorStats() {
  const { ok, data } = await apiGet(API.VISITOR_STATS);
  visitorStatsCache = ok && Array.isArray(data)
    ? data.map((item) => ({ date: new Date(item.date), count: item.count || 0 }))
    : [];
  return visitorStatsCache;
}

/**
 * 绘制参观人数统计图表
 * 在指定的canvas上绘制参观人数折线图，数据来自 API
 * @param {string} canvasId - Canvas元素的ID
 * @param {string} totalId - 总人数显示元素的ID
 */
async function drawVisitorChart(canvasId, totalId) {
  const canvas = document.getElementById(canvasId);
  const totalEl = document.getElementById(totalId);
  if (!canvas) {
    return;
  }
  
  const ctx = canvas.getContext('2d');
  const data = await loadVisitorStats();
  
  if (totalEl) {
    totalEl.textContent = data.length ? data.reduce((sum, item) => sum + item.count, 0) : '0';
  }
  
  if (data.length === 0) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  
  // 获取容器尺寸
  const container = canvas.parentElement;
  if (!container) {
    return;
  }
  
  const containerWidth = container.clientWidth || 800;
  const containerHeight = container.clientHeight || 200;
  
  // 设置canvas尺寸
  const dpr = window.devicePixelRatio || 1;
  canvas.width = containerWidth * dpr;
  canvas.height = containerHeight * dpr;
  ctx.scale(dpr, dpr);
  canvas.style.width = containerWidth + 'px';
  canvas.style.height = containerHeight + 'px';
  
  const width = containerWidth;
  const height = containerHeight;
  const padding = { top: 20, right: 20, bottom: 10, left: 40 }; // 减少底部padding，因为不显示横坐标
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  
  // 清空画布
  ctx.clearRect(0, 0, width, height);
  
  if (data.length === 0) return;
  
  // 计算数据范围
  const maxCount = Math.max(...data.map(d => d.count));
  const minCount = Math.min(...data.map(d => d.count));
  const range = maxCount - minCount || 1;
  const yScale = chartHeight / range;
  
  // 绘制网格线
  ctx.strokeStyle = 'rgba(183, 235, 143, 0.3)';
  ctx.lineWidth = 1;
  const gridLines = 5;
  for (let i = 0; i <= gridLines; i++) {
    const y = padding.top + (chartHeight / gridLines) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
    
    // Y轴标签
    const value = maxCount - (range / gridLines) * i;
    ctx.fillStyle = '#8c8c8c';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(Math.round(value), padding.left - 8, y + 4);
  }
  
  // 绘制折线
  const pointSpacing = chartWidth / (data.length - 1 || 1);
  
  // 绘制渐变区域
  const gradient = ctx.createLinearGradient(0, padding.top, 0, padding.top + chartHeight);
  gradient.addColorStop(0, 'rgba(82, 196, 26, 0.2)');
  gradient.addColorStop(1, 'rgba(82, 196, 26, 0.05)');
  
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.moveTo(padding.left, padding.top + chartHeight);
  
  data.forEach((item, index) => {
    const x = padding.left + index * pointSpacing;
    const y = padding.top + chartHeight - (item.count - minCount) * yScale;
    if (index === 0) {
      ctx.lineTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  
  ctx.lineTo(padding.left + (data.length - 1) * pointSpacing, padding.top + chartHeight);
  ctx.closePath();
  ctx.fill();
  
  // 绘制折线
  ctx.strokeStyle = '#52c41a';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  
  data.forEach((item, index) => {
    const x = padding.left + index * pointSpacing;
    const y = padding.top + chartHeight - (item.count - minCount) * yScale;
    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  
  ctx.stroke();
  
  // 绘制数据点
  ctx.fillStyle = 'var(--primary-green)';
  data.forEach((item, index) => {
    const x = padding.left + index * pointSpacing;
    const y = padding.top + chartHeight - (item.count - minCount) * yScale;
    
    // 外圈光晕
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(82, 196, 26, 0.3)';
    ctx.fill();
    
    // 内圈点
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#52c41a';
    ctx.fill();
    
    // 绘制数值标签（每隔几个点显示一个，避免拥挤）
    if (index % Math.ceil(data.length / 8) === 0 || index === data.length - 1) {
      ctx.fillStyle = '#262626';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(item.count, x, y - 10);
    }
  });
  
  // 不绘制X轴日期标签（按用户要求）
}

// ==================== 图表初始化模块 ====================
/**
 * 图表初始化模块
 * 初始化所有统计图表，并处理窗口大小改变事件
 */

/**
 * 初始化参观人数统计图表
 * 初始化所有统计图表，并监听窗口大小改变事件
 */
function initVisitorCharts() {
  setTimeout(async () => {
    requestAnimationFrame(async () => {
      await drawVisitorChart('visitor-chart', 'total-visitors');
      await drawVisitorChart('visitor-chart-license', 'total-visitors-license');
    });
  }, 100);

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(async () => {
      await drawVisitorChart('visitor-chart', 'total-visitors');
      await drawVisitorChart('visitor-chart-license', 'total-visitors-license');
    }, 250);
  });
}

// ==================== 粒子效果模块 ====================
/**
 * 粒子效果模块
 * 提供首页背景粒子动画效果
 * 支持性能优化和响应式调整
 */

// 粒子效果相关变量
let particlesAnimation = null;  // 粒子动画对象
let particlesCanvas = null;      // 粒子画布元素
let particlesCtx = null;         // 粒子画布上下文
let particles = [];              // 粒子数组
let animationFrameId = null;    // 动画帧ID

/**
 * 初始化粒子效果
 * 创建粒子系统并启动动画
 */
function initParticles() {
  particlesCanvas = document.getElementById('particles-canvas');
  if (!particlesCanvas) return;
  
  particlesCtx = particlesCanvas.getContext('2d');
  
  // 设置画布尺寸
  function resizeCanvas() {
    particlesCanvas.width = window.innerWidth;
    particlesCanvas.height = window.innerHeight;
  }
  
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  
  // 创建粒子（根据设备性能调整数量）
  const isMobile = window.innerWidth < 768;
  const isTablet = window.innerWidth >= 768 && window.innerWidth < 1024;
  const baseCount = isMobile ? 20 : (isTablet ? 35 : 50);
  const particleCount = Math.min(baseCount, Math.floor(window.innerWidth / 20));
  particles = [];
  
  for (let i = 0; i < particleCount; i++) {
    particles.push({
      x: Math.random() * particlesCanvas.width,
      y: Math.random() * particlesCanvas.height,
      radius: Math.random() * 3 + 1,
      vx: (Math.random() - 0.5) * 0.5,
      vy: (Math.random() - 0.5) * 0.5,
      opacity: Math.random() * 0.2 + 0.6,  // 进一步提高不透明度：0.6-0.8（之前是0.5-0.8）
      color: `rgba(82, 196, 26, ${Math.random() * 0.2 + 0.5})`  // 进一步提高颜色不透明度：0.5-0.7（之前是0.4-0.7）
    });
  }
  
  // 启动动画
  animateParticles();
}

/**
 * 动画粒子效果
 * 更新和绘制粒子动画
 * 全局显示：在所有页面都显示，作为全局背景
 */
function animateParticles() {
  if (!particlesCanvas || !particlesCtx) return;
  
  // 全局显示粒子效果（所有页面都显示）
  // 粒子效果作为全局背景，在所有页面都显示
  
  // 清空画布
  particlesCtx.clearRect(0, 0, particlesCanvas.width, particlesCanvas.height);
  
  // 优化：使用批量绘制提高性能
  particlesCtx.save();
  
  // 更新和绘制粒子
  particles.forEach((particle, index) => {
    // 更新位置
    particle.x += particle.vx;
    particle.y += particle.vy;
    
    // 边界检测（优化：使用更平滑的边界处理）
    if (particle.x < 0 || particle.x > particlesCanvas.width) {
      particle.vx *= -1;
      particle.x = Math.max(0, Math.min(particlesCanvas.width, particle.x));
    }
    if (particle.y < 0 || particle.y > particlesCanvas.height) {
      particle.vy *= -1;
      particle.y = Math.max(0, Math.min(particlesCanvas.height, particle.y));
    }
    
    // 绘制粒子（优化：减少绘制调用）
    particlesCtx.beginPath();
    particlesCtx.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
    particlesCtx.fillStyle = particle.color;
    particlesCtx.globalAlpha = particle.opacity;
    particlesCtx.fill();
    
    // 优化：只绘制距离较近的连接线，减少计算
    if (index < particles.length - 1) {
      for (let i = index + 1; i < particles.length; i++) {
        const otherParticle = particles[i];
        const dx = particle.x - otherParticle.x;
        const dy = particle.y - otherParticle.y;
        const distanceSq = dx * dx + dy * dy;
        
        // 使用距离平方避免开方计算
        if (distanceSq < 22500) { // 150^2
          const distance = Math.sqrt(distanceSq);
          const opacity = 0.7 * (1 - distance / 150);  // 进一步提高连接线不透明度：0-0.7（之前是0-0.6）
          
          particlesCtx.beginPath();
          particlesCtx.moveTo(particle.x, particle.y);
          particlesCtx.lineTo(otherParticle.x, otherParticle.y);
          particlesCtx.strokeStyle = `rgba(82, 196, 26, ${opacity})`;
          particlesCtx.globalAlpha = opacity;
          particlesCtx.lineWidth = 1.5;  // 保持线宽，使连接线更明显
          particlesCtx.stroke();
        }
      }
    }
  });
  
  particlesCtx.restore();
  
  // 继续动画循环
  animationFrameId = requestAnimationFrame(animateParticles);
}

// ==================== 性能优化工具模块 ====================
/**
 * 性能优化工具模块
 * 提供防抖和节流函数，优化事件处理性能
 */

/**
 * 防抖函数
 * 在指定时间内只执行最后一次调用
 * @param {Function} func - 要防抖的函数
 * @param {number} wait - 等待时间（毫秒）
 * @returns {Function} 防抖后的函数
 */
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

/**
 * 节流函数
 * 在指定时间内最多执行一次
 * @param {Function} func - 要节流的函数
 * @param {number} limit - 时间限制（毫秒）
 * @returns {Function} 节流后的函数
 */
function throttle(func, limit) {
  let inThrottle;
  return function(...args) {
    if (!inThrottle) {
      func.apply(this, args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  };
}

// ==================== 数据更新定时器模块（优化版） ====================
/**
 * 数据更新定时器模块（优化版）
 * 提供智能的数据更新机制，根据当前页面只更新需要的数据
 * 使用节流优化更新频率，避免过于频繁的更新
 */

/**
 * 启动数据更新定时器
 * 根据当前页面智能更新数据，优化性能
 */
function startUpdateTimer() {
  clearUpdateTimer();
  
  // 使用节流优化更新频率，避免过于频繁的更新
  let lastUpdateTime = 0;
  const UPDATE_INTERVAL = 2000; // 2秒更新一次
  let isUpdating = false; // 防止并发更新
  
  AppState.updateTimer = setInterval(async () => {
    const now = Date.now();
    // 确保至少间隔2秒才更新
    if (now - lastUpdateTime < UPDATE_INTERVAL || isUpdating) {
      return;
    }
    lastUpdateTime = now;
    isUpdating = true;
    
    try {
      // 优化：根据当前页面只加载需要的数据
      const initPage = document.getElementById('init-page');
      const listPage = document.getElementById('list-page');
      const detailPage = document.getElementById('detail-page');
      
      // 如果在首页，只更新信标列表（使用后端API）
      if (initPage && initPage.classList.contains('active')) {
        await renderBeaconChips(); // 使用后端API，已处理筛选和映射
        // 如果粒子效果停止，重新启动
        if (!animationFrameId) {
          animateParticles();
        }
      }
      // 如果在列表页，只更新当前信标的接收器列表（使用后端API）
      else if (listPage && listPage.classList.contains('active')) {
        if (AppState.currentBeaconMac) {
          // 优化：只加载当前信标的数据，不处理所有信标
          await renderExhibitionList(); // 使用后端API，只处理当前信标
          updateHeaderTime('update-time');
        }
      }
      // 如果在详情页，只更新时间，不处理数据
      else if (detailPage && detailPage.classList.contains('active')) {
        updateHeaderTime('detail-update-time');
      }
    } catch (error) {
    } finally {
      isUpdating = false;
    }
  }, UPDATE_INTERVAL);
}

// ==================== 悬浮AI聊天功能模块 ====================
/**
 * 悬浮AI聊天功能模块
 * 提供全局悬浮AI助手功能，支持拖拽、点击、问答等
 * 模块化设计，便于扩展和维护
 */

/**
 * 更新悬浮AI预设问题
 * 根据当前页面动态显示不同的预设问题
 */
function updateFloatingPresetQuestions() {
  const container = document.getElementById('floating-preset-questions');
  if (!container) return;
  
  container.innerHTML = '';
  
  // 根据当前页面显示不同的预设问题
  const currentPage = document.querySelector('.page.active');
  if (!currentPage) return;
  
  const currentPageId = currentPage.id;
  let questions = [];
  
  // 首页预设问题
  if (currentPageId === 'init-page') {
    questions = [
      '如何使用这个项目？',
      '这个系统有什么特点？',
      '如何选择信标？',
      '系统支持哪些功能？'
    ];
  }
  // 列表页预设问题
  else if (currentPageId === 'list-page') {
    questions = [
      '如何选择展区？',
      '展区信息如何更新？',
      '信号强度是什么意思？',
      '如何查看展区详情？'
    ];
  }
  // 详情页预设问题（使用展区的预设问题）
  else if (currentPageId === 'detail-page') {
    const exhibition = AppState.exhibitions?.[AppState.currentExhibitionId];
    if (exhibition && exhibition.aiQuestions) {
      questions = exhibition.aiQuestions;
    } else {
      questions = [
        '这个展区有什么特色？',
        '展区的主要展品是什么？',
        '展区的历史背景是什么？',
        '如何了解更多信息？'
      ];
    }
  }
  // 关于项目页面预设问题
  else if (currentPageId === 'about-page') {
    questions = [
      '项目的技术架构是什么？',
      '项目有哪些创新点？',
      '如何参与项目开发？',
      '项目的应用场景有哪些？'
    ];
  }
  // 许可证页面预设问题
  else if (currentPageId === 'license-page') {
    questions = [
      '许可证的具体内容是什么？',
      '如何使用开源代码？',
      '有哪些使用限制？',
      '如何贡献代码？'
    ];
  }
  
  // 渲染预设问题按钮
  questions.forEach(question => {
    const btn = document.createElement('button');
    btn.className = 'floating-preset-question-btn';
    btn.textContent = question;
    btn.type = 'button';
    btn.addEventListener('click', () => {
      const input = document.getElementById('floating-custom-input');
      if (input) {
        input.value = question;
        handleFloatingAIQuestion();
      }
    });
    container.appendChild(btn);
  });
}

/**
 * 处理悬浮AI问题
 * 发送问题到后端API并显示回答
 */
async function handleFloatingAIQuestion() {
  const input = document.getElementById('floating-custom-input');
  const askBtn = document.getElementById('floating-ask-btn');
  const question = input?.value.trim();
  
  if (!question) {
    return;
  }
  
  // 禁用输入和按钮
  if (input) input.disabled = true;
  if (askBtn) askBtn.disabled = true;
  showFloatingAILoading();
  try {
    const { ok, data, message } = await apiPost(API.AI_CHAT, {
      question,
      receiverId: AppState.currentReceiverId,
      beaconId: AppState.currentBeaconId
    });
    const answer = (ok && data && data.answer) ? data.answer : (message || '抱歉，无法获取回答，请稍后重试。');
    displayFloatingAIAnswer(answer);
  } catch (error) {
    displayFloatingAIAnswer('抱歉，服务暂时不可用，请稍后重试。');
  } finally {
    // 恢复输入和按钮
    if (input) {
      input.disabled = false;
      input.value = '';
    }
    if (askBtn) askBtn.disabled = false;
  }
}

/**
 * 显示悬浮AI加载状态
 * 在AI思考时显示加载动画
 */
function showFloatingAILoading() {
  const container = document.getElementById('floating-ai-answer-container');
  if (!container) return;
  
  container.innerHTML = `
    <div class="floating-answer-loading">
      <span>AI正在思考</span>
      <span class="loading-dots">
        <span></span>
        <span></span>
        <span></span>
      </span>
    </div>
  `;
  
  // 滚动到底部
  container.scrollTop = container.scrollHeight;
}

/**
 * 显示悬浮AI回答（带打字机效果）
 * 格式化并显示AI的回答内容，使用打字机效果逐字显示
 * @param {string} answer - AI回答的文本内容
 */
function displayFloatingAIAnswer(answer) {
  const container = document.getElementById('floating-ai-answer-container');
  if (!container) return;
  
  // 简单的Markdown渲染
  const formattedAnswer = formatMarkdown(answer);
  
  // 清空容器
  container.innerHTML = '<div class="floating-answer-content"></div>';
  const contentDiv = container.querySelector('.floating-answer-content');
  
  // 打字机效果
  let index = 0;
  const speed = 20; // 打字速度（毫秒/字符）
  
  function typeWriter() {
    if (index < formattedAnswer.length) {
      // 获取当前要显示的文本
      const currentText = formattedAnswer.substring(0, index + 1);
      contentDiv.innerHTML = currentText;
      
      // 滚动到底部
      container.scrollTop = container.scrollHeight;
      
      index++;
      setTimeout(typeWriter, speed);
    }
  }
  
  // 开始打字机效果
  typeWriter();
}

// ==================== 彩蛋功能 ====================
function initEasterEgg() {
  const logoCircle = document.querySelector('.logo-circle');
  if (!logoCircle) return;
  
  logoCircle.addEventListener('click', () => {
    const now = Date.now();
    if (now - AppState.lastLogoClickTime > 3000) {
      AppState.logoClickCount = 0;
    }
    
    AppState.logoClickCount++;
    AppState.lastLogoClickTime = now;
    
    if (AppState.logoClickCount >= 5) {
      triggerEasterEgg();
      AppState.logoClickCount = 0;
    }
  });
}

function triggerEasterEgg() {
  const logoCircle = document.querySelector('.logo-circle');
  if (!logoCircle) return;
  
  createFlowerExplosion(logoCircle);
  
  setTimeout(() => {
    navigateToEasterEggPage();
  }, 1200);
}

function createFlowerExplosion(element) {
  const rect = element.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  
  const petalCount = 16;
  const petals = [];
  
  for (let i = 0; i < petalCount; i++) {
    const petal = document.createElement('div');
    petal.className = 'flower-petal';
    petal.style.position = 'fixed';
    petal.style.left = centerX + 'px';
    petal.style.top = centerY + 'px';
    petal.style.width = '50px';
    petal.style.height = '50px';
    petal.style.borderRadius = '50%';
    const hue = (i * 22.5) % 360;
    petal.style.background = `radial-gradient(circle, hsl(${hue}, 100%, 70%), hsl(${hue}, 100%, 50%))`;
    petal.style.boxShadow = `0 0 20px hsl(${hue}, 100%, 60%), 0 0 40px hsl(${hue}, 100%, 50%)`;
    petal.style.pointerEvents = 'none';
    petal.style.zIndex = '10000';
    petal.style.opacity = '0';
    petal.style.transform = 'scale(0)';
    
    document.body.appendChild(petal);
    petals.push(petal);
    
    const angle = (i / petalCount) * Math.PI * 2;
    const distance = 350 + (i % 2) * 100;
    const endX = centerX + Math.cos(angle) * distance;
    const endY = centerY + Math.sin(angle) * distance;
    
    requestAnimationFrame(() => {
      petal.style.transition = 'all 1.2s cubic-bezier(0.34, 1.56, 0.64, 1)';
      petal.style.opacity = '1';
      petal.style.transform = `translate(${endX - centerX}px, ${endY - centerY}px) scale(1.8) rotate(720deg)`;
      
      setTimeout(() => {
        const currentTransform = petal.style.transform;
        petal.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
        petal.style.opacity = '0';
        petal.style.transform = currentTransform.replace('scale(1.8)', 'scale(0.5)');
        setTimeout(() => {
          petal.remove();
        }, 500);
      }, 700);
    });
  }
  const centerExplosion = document.createElement('div');
  centerExplosion.className = 'center-explosion';
  centerExplosion.style.position = 'fixed';
  centerExplosion.style.left = centerX + 'px';
  centerExplosion.style.top = centerY + 'px';
  centerExplosion.style.width = '0';
  centerExplosion.style.height = '0';
  centerExplosion.style.borderRadius = '50%';
  centerExplosion.style.background = 'radial-gradient(circle, rgba(82, 196, 26, 0.8), rgba(82, 196, 26, 0))';
  centerExplosion.style.transform = 'translate(-50%, -50%)';
  centerExplosion.style.pointerEvents = 'none';
  centerExplosion.style.zIndex = '9999';
  document.body.appendChild(centerExplosion);
  
  requestAnimationFrame(() => {
    centerExplosion.style.transition = 'all 0.8s cubic-bezier(0.34, 1.56, 0.64, 1)';
    centerExplosion.style.width = '500px';
    centerExplosion.style.height = '500px';
    centerExplosion.style.opacity = '0';
    
    setTimeout(() => {
      centerExplosion.remove();
    }, 800);
  });
}

function navigateToEasterEggPage() {
  const easterEggPage = document.getElementById('easter-egg-page');
  const currentPage = document.querySelector('.page.active');
  
  if (!easterEggPage || !currentPage) return;
  
  easterEggPage.style.display = 'flex';
  currentPage.classList.add('slide-out-flower');
  easterEggPage.classList.add('slide-in-flower');
  
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      currentPage.classList.remove('active');
      easterEggPage.classList.add('active');
      initEasterEggPageAnimations();
      
      setTimeout(() => {
        currentPage.classList.remove('slide-out-flower');
        easterEggPage.classList.remove('slide-in-flower');
        currentPage.style.display = 'none';
        currentPage.style.transform = '';
        currentPage.style.filter = '';
        easterEggPage.style.transform = '';
        easterEggPage.style.filter = '';
      }, 600);
    });
  });
}

function initEasterEggPageAnimations() {
  const titleWrappers = document.querySelectorAll('.easter-egg-title-wrapper');
  const divider = document.querySelector('.easter-egg-divider');
  
  titleWrappers.forEach((wrapper, index) => {
    setTimeout(() => {
      wrapper.style.animation = 'fadeInUp 0.8s cubic-bezier(0.34, 1.56, 0.64, 1) forwards';
    }, index * 200);
  });
  
  if (divider) {
    setTimeout(() => {
      divider.style.animation = 'expandLine 1s cubic-bezier(0.34, 1.56, 0.64, 1) forwards';
    }, 400);
  }
  
  createTechParticles();
  createTechGrid();
}

function createTechParticles() {
  const container = document.querySelector('.easter-egg-particles');
  if (!container) return;

  container.innerHTML = '';

  for (let i = 0; i < 50; i++) {
    const particle = document.createElement('div');
    particle.className = 'tech-particle';
    particle.style.left = Math.random() * 100 + '%';
    particle.style.top = Math.random() * 100 + '%';
    particle.style.animationDelay = Math.random() * 2 + 's';
    particle.style.animationDuration = (Math.random() * 3 + 2) + 's';
    container.appendChild(particle);
  }
}

function createTechGrid() {
  const container = document.querySelector('.easter-egg-grid');
  if (!container) return;

  container.innerHTML = '';

  for (let i = 0; i < 20; i++) {
    const line = document.createElement('div');
    line.className = 'tech-grid-line';
    line.style.left = (i * 5) + '%';
    line.style.animationDelay = (i * 0.1) + 's';
    container.appendChild(line);
  }

  for (let i = 0; i < 20; i++) {
    const line = document.createElement('div');
    line.className = 'tech-grid-line tech-grid-line-vertical';
    line.style.top = (i * 5) + '%';
    line.style.animationDelay = (i * 0.1) + 's';
    container.appendChild(line);
  }
}

// ==================== 页面卸载时清理 ====================
window.addEventListener('beforeunload', () => {
  clearUpdateTimer();
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
  }
});