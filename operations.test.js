process.env.NODE_ENV = 'test';
process.env.LINE_CHANNEL_SECRET = 'operations-test-secret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'operations-test-token';
process.env.MONGO_URI = 'mongodb://not-used-during-tests';
process.env.TEST_MODE = 'true';
process.env.UNSEND_AUTO_PUSH = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const axios = require('axios');
const { unzipSync, strFromU8 } = require('fflate');
const bot = require('./index');

function matchValue(actual, expected) {
  if (expected && typeof expected === 'object' && '$regex' in expected) return expected.$regex.test(actual);
  if (expected && typeof expected === 'object' && '$ne' in expected) return actual !== expected.$ne;
  if (Array.isArray(actual)) return actual.includes(expected);
  return actual === expected;
}

function matches(record, query) {
  return Object.entries(query).every(([key, expected]) => {
    if (key === '$or') return expected.some(branch => matches(record, branch));
    return matchValue(record[key], expected);
  });
}

function createCollection(initial = []) {
  const records = structuredClone(initial);
  return {
    records,
    find(query) {
      let found = records.filter(record => matches(record, query));
      return {
        sort(spec = {}) {
          const entries = Object.entries(spec);
          found.sort((a, b) => entries.reduce((result, [key, direction]) => result ||
            direction * (String(a[key] ?? '').localeCompare(String(b[key] ?? ''))), 0));
          return this;
        },
        limit(count) { found = found.slice(0, count); return this; },
        async toArray() { return structuredClone(found); },
      };
    },
    async findOne(query) { return structuredClone(records.find(record => matches(record, query)) || null); },
    async updateOne(query, update, options = {}) {
      let record = records.find(item => matches(item, query));
      if (!record && options.upsert) { record = { ...query }; records.push(record); }
      if (record) Object.assign(record, update.$set || {});
      return { acknowledged: true, matchedCount: record ? 1 : 0 };
    },
    async updateMany(query, update) {
      const found = records.filter(item => matches(item, query));
      found.forEach(record => Object.assign(record, update.$set || {}));
      return { acknowledged: true, matchedCount: found.length };
    },
  };
}

async function withWebhook(collection, fn) {
  bot.__setOrdersCollectionForTests(collection);
  const originalPost = axios.post;
  const replies = [];
  axios.post = async (_url, payload) => { replies.push(payload.messages.map(message => message.text).join('\n')); };
  const server = bot.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let sequence = 0;
  async function post(text, { groupId = 'operations-group', quotedMessageId } = {}) {
    sequence++;
    const body = JSON.stringify({ events: [{
      type: 'message', replyToken: `reply-${sequence}`, timestamp: Date.now() + sequence,
      source: { type: 'group', groupId, userId: 'driver-one' },
      message: { type: 'text', id: `message-${sequence}`, text, ...(quotedMessageId ? { quotedMessageId } : {}) },
    }] });
    const signature = crypto.createHmac('sha256', process.env.LINE_CHANNEL_SECRET).update(body).digest('base64');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/webhook`, {
      method: 'POST', body, headers: { 'content-type': 'application/json', 'x-line-signature': signature },
    });
    assert.equal(response.status, 200);
    return replies.at(-1) || '';
  }
  try { await fn({ post, records: collection.records, replies }); }
  finally {
    axios.post = originalPost;
    bot.__setOrdersCollectionForTests(null);
    await new Promise(resolve => server.close(resolve));
  }
}

const formalOrder = [
  '送機', 'OPS123456', '出發日期:11/8', '乘車人數:2', '行李數量:2',
  '航班編號:BR123【09:00】', '上車地點:台北市中山區南京東路1號',
  '下車地點:桃園機場', '其他備註:', '聯絡人:測試', '電話:0912345678', '結算價1000',
].join('\n');

test('00至23整點補單一律保留兩位數字', () => {
  for (let hour = 0; hour <= 23; hour++) {
    const raw = String(hour).padStart(2, '0');
    const placeholder = bot.parsePlaceholder(`補${raw}接`);
    assert.equal(placeholder.time, `${raw}:00`);
    assert.equal(placeholder.display, `補${raw}接`);
  }
  assert.equal(bot.placeholderMatchesOrder(
    { isPlaceholder: true, hour: 4, time: '04:00', type: '接', display: '補4接' },
    { time: '04:50', type: '接' },
  ), true);
  const legacySummary = bot.buildSummary('legacy-placeholder', '11/8', {
    placeholder: { isPlaceholder: true, hour: 4, time: '04:00', type: '接', display: '補4接' },
    formal: { time: '04:50', type: '接', loc: '台北市中山區', pax: 1, price: 800, remarks: [] },
  });
  assert.doesNotMatch(legacySummary, /補4接/);
  assert.match(legacySummary, /04:50/);
});

test('桃小巴兩種格式、時數及每3小時2000元換算正確', () => {
  const short = bot.parseMinibusShift('1320-1520桃小巴');
  assert.equal(short.time, '13:20');
  assert.equal(short.endTime, '15:20');
  assert.equal(short.durationMinutes, 120);
  assert.equal(short.minibusPerformance, 1333.33);
  assert.equal(bot.parseMinibusShift('1320-1620桃小巴').minibusPerformance, 2000);
  const dated = bot.parseMinibusShift('11/8 0610-1410 桃小巴桃園區 一車');
  assert.equal(dated.date, '11/8');
  assert.equal(dated.durationMinutes, 480);
  assert.equal(dated.minibusPerformance, 5333.33);
  assert.equal(dated.minibusLabel, '桃小巴桃園區 一車');
});

test('桃小巴依開始時間併入簡表並分開顯示時數與業績', () => {
  const minibus = bot.parseMinibusShift('11/8 1320-1520 桃小巴');
  const summary = bot.buildSummary('mix-group', '11/8', {
    airport: { time: '09:00', type: '送', loc: '台北市中山區', pax: 2, price: 1000, remarks: [] },
    minibus,
  });
  assert.ok(summary.indexOf('09:00') < summary.indexOf('13:20–15:20'));
  assert.match(summary, /桃小巴時數合計：2小時/);
  assert.match(summary, /桃小巴業績合計：1333\.3/);
  assert.match(summary, /機場接送業績合計：1000/);
  assert.match(summary, /業績合計：2333\.3/);
});

test('沒有桃小巴班次的群組不顯示桃小巴欄位', () => {
  const summary = bot.buildSummary('airport-only', '11/8', {
    airport: { time: '09:00', type: '送', loc: '台北市中山區', pax: 2, price: 1000, remarks: [] },
  });
  assert.doesNotMatch(summary, /桃小巴/);
  assert.match(summary, /業績合計：1000/);
});

test('舉牌訂單文字只要包含自接即自動標記且不扣100元', () => {
  const text = formalOrder.replace('其他備註:', '其他備註:舉牌，這筆自接');
  const [order] = bot.parseOrders(text);
  assert.equal(order.placardSelfPickup, true);
  assert.equal(bot.getPlacardDeduction(order), 0);
  assert.match(bot.buildSummary('self-pick', '11/8', { one: order }), /舉牌\*/);
});

test('含舉牌與自接的完整訂單可直接經Webhook保存，不需另外回覆', async () => {
  const collection = createCollection();
  await withWebhook(collection, async ({ post, records }) => {
    const text = formalOrder.replace('其他備註:', '其他備註:舉牌，司機自接');
    const summary = await post(text);
    const saved = records.find(record => record.orderId === 'OPS123456' && !record.cancelled);
    assert.equal(saved.placardSelfPickup, true);
    assert.match(summary, /舉牌\*/);
    assert.doesNotMatch(summary, /舉牌服務扣款：100/);
  });
});

test('回覆舉牌原訊息只要含自接兩字即可標記', async () => {
  const collection = createCollection([{
    groupId: 'operations-group', serviceYear: 2026, date: '11/8', key: 'SIGN001', orderId: 'SIGN001',
    lineMessageId: 'placard-original', time: '09:00', type: '送', loc: '台北市中山區', pax: 2,
    price: 1000, remarks: ['舉牌'], cancelled: false,
  }]);
  await withWebhook(collection, async ({ post, records }) => {
    const reply = await post('這筆我來自接，謝謝', { quotedMessageId: 'placard-original' });
    assert.equal(records[0].placardSelfPickup, true);
    assert.match(reply, /舉牌\*/);
    assert.match(reply, /業績合計：1000/);
  });
});

test('正式訂單補入後自動取代同時間同方向補單', async () => {
  const collection = createCollection();
  await withWebhook(collection, async ({ post, records }) => {
    assert.match(await post('11/8 補09送'), /補09送/);
    const summary = await post(formalOrder);
    assert.doesNotMatch(summary, /補09送/);
    assert.match(summary, /09:00/);
    assert.equal(records.filter(record => record.isPlaceholder && !record.cancelled).length, 0);
  });
});

test('整點補單會被同一小時內的正式訂單取代', async () => {
  const collection = createCollection();
  await withWebhook(collection, async ({ post, records }) => {
    assert.match(await post('11/8 補04送'), /補04送/);
    const orderAt0430 = formalOrder.replace('【09:00】', '【04:30】');
    const summary = await post(orderAt0430);
    assert.doesNotMatch(summary, /補04送/);
    assert.match(summary, /04:30/);
    assert.equal(records.filter(record => record.isPlaceholder && !record.cancelled).length, 0);
  });
});

test('已有正式訂單時不再新增同時間同方向補單', async () => {
  const collection = createCollection();
  await withWebhook(collection, async ({ post, records }) => {
    await post(formalOrder);
    const reply = await post('11/8 補09送');
    assert.match(reply, /已有正式訂單，未新增重複補單/);
    assert.equal(records.filter(record => record.isPlaceholder && !record.cancelled).length, 0);
  });
});

test('桃小巴只寫入收到班次的群組，月結與Excel分開計算', async () => {
  const collection = createCollection();
  await withWebhook(collection, async ({ post, records }) => {
    const summary = await post('11/8 0610-1410 桃小巴桃園區 一車');
    assert.match(summary, /06:10–14:10/);
    assert.match(summary, /桃小巴時數合計：8小時/);
    assert.match(summary, /桃小巴業績合計：5333\.3/);
    assert.equal(records.filter(record => record.groupId === 'operations-group' && record.isMinibus).length, 1);
    assert.equal(records.filter(record => record.groupId === 'other-group' && record.isMinibus).length, 0);
    assert.doesNotMatch(await bot.buildRequestedSummary('other-group', '11/8'), /桃小巴/);
    const diagnostic = await bot.buildGroupDiagnostic('operations-group', { senderId: 'driver-one', conversationType: 'group' }, new Date('2026-11-08T04:00:00Z'), '11/8');
    assert.match(diagnostic, /桃小巴班次：1 筆/);
    assert.match(diagnostic, /桃小巴時數：8小時/);
    assert.match(diagnostic, /桃小巴業績：5333\.3/);
    const report = await bot.buildMonthlyReport('operations-group', 11, 2026);
    assert.match(report, /桃小巴時數：8小時/);
    assert.match(report, /桃小巴業績：5333\.3/);
    const workbook = await bot.buildMonthlyWorkbook('operations-group', 11, 2026);
    const files = unzipSync(new Uint8Array(workbook));
    const sheet1 = strFromU8(files['xl/worksheets/sheet1.xml']);
    const sheet2 = strFromU8(files['xl/worksheets/sheet2.xml']);
    assert.match(sheet1, /桃小巴時數/);
    assert.match(sheet1, /5333\.33/);
    assert.match(sheet2, /桃小巴桃園區 一車/);
  });
});

test('同日起始時間的桃小巴班次重貼修正時數不會重複', async () => {
  const collection = createCollection();
  await withWebhook(collection, async ({ post, records }) => {
    await post('11/8 0610-1410 桃小巴桃園區 一車');
    const summary = await post('11/8 0610-1510 桃小巴桃園區 一車');
    assert.equal(records.filter(record => record.isMinibus && !record.cancelled).length, 1);
    assert.match(summary, /06:10–15:10/);
    assert.match(summary, /桃小巴時數合計：9小時/);
    assert.match(summary, /桃小巴業績合計：6000/);
  });
});
