// functions/[[path]].js
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // 跨域 CORS 请求头
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  // 处理浏览器预检请求
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // 统一 JSON 响应工具函数
  const send = (data, status = 200) => {
    return new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  };

  // 检查 D1 数据库绑定是否存在
  if (!env.DB) {
    return send({ 
      ok: false, 
      msg: '服务端未检测到 D1 数据库绑定，请在 Cloudflare Pages 设置中将 D1 绑定命名为 "DB"' 
    }, 500);
  }

  try {
    // 1. 验证激活码并绑定设备登录
    if (url.pathname === '/api/login' && request.method === 'POST') {
      const { code, deviceId } = await request.json();
      if (!code || !deviceId) {
        return send({ ok: false, msg: '缺少必要参数：code 或 deviceId' }, 400);
      }

      // 查询激活码记录
      const row = await env.DB.prepare('SELECT * FROM licenses WHERE code = ?')
        .bind(code.trim())
        .first();

      if (!row) {
        return send({ ok: false, msg: '激活码不存在或无效' }, 404);
      }

      let devices = [];
      try {
        devices = JSON.parse(row.active_devices || '[]');
      } catch (e) {
        devices = [];
      }

      // 若当前设备已在列表中，直接放行
      if (devices.includes(deviceId)) {
        return send({ ok: true, msg: '设备已在列表中，登录成功', devicesCount: devices.length });
      }

      const maxLimit = row.max_devices || 2;
      // 检查设备数量限制（2台）
      if (devices.length >= maxLimit) {
        return send({ 
          ok: false, 
          code: 'DEVICE_LIMIT',
          msg: `已达登录设备上限(${maxLimit}台)。请先在其他已登录设备点击“退出登录”，或在此强制解绑旧设备。` 
        }, 403);
      }

      // 绑定新设备
      devices.push(deviceId);
      await env.DB.prepare('UPDATE licenses SET active_devices = ? WHERE code = ?')
        .bind(JSON.stringify(devices), code.trim())
        .run();

      return send({ ok: true, msg: '登录成功并绑定当前设备', devicesCount: devices.length });
    }

    // 2. 退出登录（释放设备名额）
    if (url.pathname === '/api/logout' && request.method === 'POST') {
      const { code, deviceId } = await request.json();
      if (!code || !deviceId) {
        return send({ ok: false, msg: '缺少参数' }, 400);
      }

      const row = await env.DB.prepare('SELECT active_devices FROM licenses WHERE code = ?')
        .bind(code.trim())
        .first();

      if (row) {
        let devices = [];
        try {
          devices = JSON.parse(row.active_devices || '[]');
        } catch (e) {
          devices = [];
        }
        devices = devices.filter(d => d !== deviceId);
        await env.DB.prepare('UPDATE licenses SET active_devices = ? WHERE code = ?')
          .bind(JSON.stringify(devices), code.trim())
          .run();
      }
      return send({ ok: true, msg: '设备已成功解绑退出' });
    }

    // 3. 强制重置设备（踢出其他设备，仅保留当前设备）
    if (url.pathname === '/api/force-reset-devices' && request.method === 'POST') {
      const { code, deviceId } = await request.json();
      if (!code || !deviceId) {
        return send({ ok: false, msg: '缺少参数' }, 400);
      }

      const row = await env.DB.prepare('SELECT * FROM licenses WHERE code = ?')
        .bind(code.trim())
        .first();

      if (!row) {
        return send({ ok: false, msg: '激活码无效' }, 404);
      }

      const newDevices = [deviceId];
      await env.DB.prepare('UPDATE licenses SET active_devices = ? WHERE code = ?')
        .bind(JSON.stringify(newDevices), code.trim())
        .run();

      return send({ ok: true, msg: '已强制清空其他旧设备，当前设备已成功绑定' });
    }

    // 4. 上传云端存档
    if (url.pathname === '/api/save/upload' && request.method === 'POST') {
      const { code, deviceId, saveData } = await request.json();
      if (!code || !saveData) {
        return send({ ok: false, msg: '缺少必要参数' }, 400);
      }

      const row = await env.DB.prepare('SELECT active_devices FROM licenses WHERE code = ?')
        .bind(code.trim())
        .first();

      if (!row) {
        return send({ ok: false, msg: '未授权的激活码' }, 403);
      }

      let devices = [];
      try {
        devices = JSON.parse(row.active_devices || '[]');
      } catch (e) {
        devices = [];
      }

      if (!devices.includes(deviceId)) {
        return send({ ok: false, msg: '当前设备已被注销或未登录' }, 403);
      }

      // 写入或更新存档
      await env.DB.prepare(`
        INSERT INTO user_saves (code, save_data, updated_at) 
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(code) DO UPDATE SET save_data = excluded.save_data, updated_at = CURRENT_TIMESTAMP
      `).bind(code.trim(), typeof saveData === 'string' ? saveData : JSON.stringify(saveData)).run();

      return send({ ok: true, msg: '存档已成功同步至云端', time: new Date().toISOString() });
    }

    // 5. 下载云端存档
    if (url.pathname === '/api/save/download' && request.method === 'POST') {
      const { code, deviceId } = await request.json();
      if (!code) {
        return send({ ok: false, msg: '缺少必要参数' }, 400);
      }

      const row = await env.DB.prepare('SELECT active_devices FROM licenses WHERE code = ?')
        .bind(code.trim())
        .first();

      if (!row) {
        return send({ ok: false, msg: '未授权的激活码' }, 403);
      }

      let devices = [];
      try {
        devices = JSON.parse(row.active_devices || '[]');
      } catch (e) {
        devices = [];
      }

      if (!devices.includes(deviceId)) {
        return send({ ok: false, msg: '当前设备未获得授权' }, 403);
      }

      const saveRow = await env.DB.prepare('SELECT save_data, updated_at FROM user_saves WHERE code = ?')
        .bind(code.trim())
        .first();

      if (!saveRow || !saveRow.save_data) {
        return send({ ok: false, msg: '云端暂无此账号的历史存档' }, 404);
      }

      return send({ ok: true, saveData: saveRow.save_data, updatedAt: saveRow.updated_at });
    }

    // 未匹配到 API 路由时，交还给静态网页资源处理
    return context.next();
  } catch (err) {
    return send({ ok: false, msg: 'Pages 后端执行异常: ' + err.message }, 500);
  }
}