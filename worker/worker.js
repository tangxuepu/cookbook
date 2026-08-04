// 做饭助手 - AI 识图中转 Worker (Service Worker 格式)
// 保护 API key：前端只传图片，Worker 负责调用三方 LLM
// 部署：curl PUT /workers/scripts/cookbook-ai-import

// CORS 头
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(origin)
    }
  });
}

async function recognizeRecipe(images) {
  const apiKey = globalThis.LLM_API_KEY;
  const baseUrl = globalThis.LLM_BASE_URL || 'https://api.llm-token.cn/v1';
  const model = globalThis.LLM_MODEL || 'claude-sonnet-4-6';

  const content = [
    {
      type: 'text',
      text: `你是专业的菜谱整理助手。用户上传了做菜教程的截图（可能多张，按做菜顺序排列）。
请仔细阅读图片内容，整理成结构化菜谱。

要求：
1. 菜名：从图片中识别
2. 食材清单：每行一种，格式「食材名 + 用量」（用量不确定就只写食材名）
3. 准备工作：切菜、调酱、泡发等前置操作
4. 步骤：按做菜顺序，每条步骤包含 main（主步骤，简洁）和 detail（说明/注意事项/火候/时间等细节）
5. 掌勺心得：图片中特别提示的注意事项、容易出错的地方
6. 如果图片信息不足，宁可留空也不要编造
7. 只返回 JSON，不要任何解释文字

返回格式（严格 JSON）：
{
  "name": "菜名",
  "category": "荤菜|素菜|主食|汤羹|小吃|饮品|其他",
  "ingredients": ["五花肉 500g", "冰糖 30g"],
  "prep": ["五花肉切 2cm 方块"],
  "steps": [{"main": "炒糖色", "detail": "小火慢炒，糖色变琥珀色立即下肉"}],
  "pits": ["糖色容易炒糊，一定小火"]
}`
    },
    ...images.map(b64 => ({
      type: 'image_url',
      image_url: { url: b64 }
    }))
  ];

  const payload = {
    model,
    messages: [{ role: 'user', content }],
    max_tokens: 2000,
    temperature: 0.3
  };

  const res = await fetch(baseUrl + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LLM API ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content || '';
  return parseRecipeJSON(raw);
}

function parseRecipeJSON(raw) {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('模型返回格式不正确');
  const obj = JSON.parse(text.slice(start, end + 1));

  const recipe = {
    name: String(obj.name || '').trim(),
    category: String(obj.category || '').trim(),
    ingredients: Array.isArray(obj.ingredients) ? obj.ingredients.map(String).map(s => s.trim()).filter(Boolean) : [],
    prep: Array.isArray(obj.prep) ? obj.prep.map(String).map(s => s.trim()).filter(Boolean) : [],
    steps: Array.isArray(obj.steps) ? obj.steps
      .map(s => typeof s === 'string' ? { main: s, detail: '' } : { main: String(s.main || '').trim(), detail: String(s.detail || '').trim() })
      .filter(s => s.main) : [],
    pits: Array.isArray(obj.pits) ? obj.pits.map(String).map(s => s.trim()).filter(Boolean) : [],
  };

  if (!recipe.name) throw new Error('未能识别出菜名，请检查图片是否清晰');
  return recipe;
}

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const origin = request.headers.get('Origin') || '';

  // OPTIONS 预检
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  const url = new URL(request.url);
  if (request.method !== 'POST' || !url.pathname.endsWith('/import')) {
    return json({ error: 'Not found' }, 404, origin);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'Invalid JSON' }, 400, origin);
  }

  const images = Array.isArray(body.images) ? body.images : [];
  if (!images.length) return json({ error: '没有收到图片' }, 400, origin);
  if (images.length > 9) return json({ error: '一次最多上传 9 张图片' }, 400, origin);

  try {
    const recipe = await recognizeRecipe(images);
    return json({ recipe }, 200, origin);
  } catch (err) {
    console.error('recognize error:', err.message);
    return json({ error: 'AI 识别失败：' + err.message }, 502, origin);
  }
}
