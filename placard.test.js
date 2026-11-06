process.env.NODE_ENV = 'test';
process.env.LINE_CHANNEL_SECRET = 'placard-test-secret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'placard-test-token';
process.env.MONGO_URI = 'mongodb://not-used-during-tests';
process.env.TEST_MODE = 'true';
process.env.UNSEND_AUTO_PUSH = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const axios = require('axios');
const { unzipSync, strFromU8 } = require('fflate');
const bot = require('./index');

function matches(record, query) {
  return Object.entries(query).every(([key, value]) => {
    if (value && typeof value === 'object' && '$regex' in value) return value.$regex.test(record[key]);
    if (Array.isArray(record[key])) return record[key].includes(value);
    return record[key] === value;
  });
}

function placardOrder(overrides = {}) {
  return {
    groupId: 'placard-group', serviceYear: 2026, date: '11/6', key: 'SIGN001', orderId: 'SIGN001',
    lineMessageId: 'original-order-message', time: '09:00', type: '接', loc: '台北市中山區',
    pax: 2, price: 1000, remarks: ['舉牌'], cancelled: false, updatedAt: new Date('2026-11-06T01:00:00Z'),
    ...overrides,
  };
}

test('一般舉牌訂單扣100元，簡表仍保留舉牌', () => {
  const summary = bot.buildSummary('placard-summary', '11/6', { one: placardOrder() });
  assert.match(summary, /1。09:00，接台北中山，舉牌，2人，1000/);
  assert.match(summary, /結算價合計：1000/);
  assert.match(summary, /舉牌服務扣款：100（1筆）/);
  assert.match(summary, /業績合計：900/);
  assert.equal(bot.getPlacardDeduction(placardOrder()), 100);
});

test('客上自接或司機自接顯示舉牌星號且不扣100元', () => {
  for (const type of ['客上自接', '司機自接']) {
    const order = placardOrder({ placardSelfPickup: true, placardSelfPickupType: type });
    const summary = bot.buildSummary('placard-self', '11/6', { one: order });
    assert.match(summary, /舉牌\*/);
    assert.match(summary, /業績合計：1000/);
    assert.match(summary, /\*：客上自接／司機自接，本筆不扣舉牌服務費/);
    assert.doesNotMatch(summary, /舉牌服務扣款：100/);
    assert.equal(bot.getPlacardDeduction(order), 0);
  }
});

test('回覆原始舉牌訂單輸入司機自接會精準更新該群組並回覆新簡表', async () => {
  const records = [placardOrder(), placardOrder({ groupId: 'other-group' })];
  bot.__setOrdersCollectionForTests({
    find(query) {
      const found = records.filter(record => matches(record, query));
      return { sort() { return this; }, limit() { return this; }, async toArray() { return structuredClone(found); } };
    },
    async updateMany(query, update) {
      const found = records.filter(record => matches(record, query));
      found.forEach(record => Object.assign(record, update.$set));
      return { acknowledged: true, matchedCount: found.length };
    },
  });
  const originalPost = axios.post;
  let reply = '';
  axios.post = async (_url, payload) => { reply = payload.messages.map(message => message.text).join('\n'); };
  const server = bot.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const body = JSON.stringify({ events: [{
      type: 'message', replyToken: 'placard-reply', timestamp: Date.now(),
      source: { type: 'group', groupId: 'placard-group', userId: 'driver-one' },
      message: { type: 'text', id: 'self-pick-message', quotedMessageId: 'original-order-message', text: '司機自接' },
    }] });
    const signature = crypto.createHmac('sha256', process.env.LINE_CHANNEL_SECRET).update(body).digest('base64');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/webhook`, {
      method: 'POST', body, headers: { 'content-type': 'application/json', 'x-line-signature': signature },
    });
    assert.equal(response.status, 200);
    assert.equal(records[0].placardSelfPickup, true);
    assert.equal(records[0].placardSelfPickupType, '司機自接');
    assert.equal(records[1].placardSelfPickup, undefined);
    assert.match(reply, /已標記「司機自接」/);
    assert.match(reply, /舉牌\*/);
    assert.match(reply, /業績合計：1000/);
  } finally {
    axios.post = originalPost;
    bot.__setOrdersCollectionForTests(null);
    await new Promise(resolve => server.close(resolve));
  }
});

test('沒有回覆原始訂單時不允許標記自接', async () => {
  let writes = 0;
  bot.__setOrdersCollectionForTests({ async updateMany() { writes++; }, find() { return { async toArray() { return []; } }; } });
  const originalPost = axios.post;
  let reply = '';
  axios.post = async (_url, payload) => { reply = payload.messages.map(message => message.text).join('\n'); };
  const server = bot.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const body = JSON.stringify({ events: [{
      type: 'message', replyToken: 'no-quote-reply', timestamp: Date.now(),
      source: { type: 'group', groupId: 'placard-group', userId: 'driver-one' },
      message: { type: 'text', id: 'no-quote-message', text: '客上自接' },
    }] });
    const signature = crypto.createHmac('sha256', process.env.LINE_CHANNEL_SECRET).update(body).digest('base64');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/webhook`, {
      method: 'POST', body, headers: { 'content-type': 'application/json', 'x-line-signature': signature },
    });
    assert.equal(response.status, 200);
    assert.equal(writes, 0);
    assert.match(reply, /請使用 LINE「回覆」原始舉牌訂單/);
  } finally {
    axios.post = originalPost;
    bot.__setOrdersCollectionForTests(null);
    await new Promise(resolve => server.close(resolve));
  }
});

test('月結、診斷與Excel使用相同舉牌扣款口徑', async () => {
  const records = [
    placardOrder({ key: 'SIGN001', orderId: 'SIGN001' }),
    placardOrder({ key: 'SIGN002', orderId: 'SIGN002', time: '10:00', price: 800, placardSelfPickup: true, placardSelfPickupType: '客上自接' }),
  ];
  bot.__setOrdersCollectionForTests({
    find(query) {
      const found = records.filter(record => matches(record, query));
      return { sort() { return this; }, limit() { return this; }, async toArray() { return structuredClone(found); } };
    },
  });
  try {
    const report = await bot.buildMonthlyReport('placard-group', 11, 2026);
    assert.match(report, /結算價總額：1800/);
    assert.match(report, /舉牌服務扣款：100（1筆）/);
    assert.match(report, /業績總額：1700/);
    assert.match(report, /舉牌自接：1筆/);
    const diagnostic = await bot.buildGroupDiagnostic('placard-group', { senderId: 'driver', conversationType: 'group' }, new Date('2026-11-06T04:00:00Z'), '2026/11/6');
    assert.match(diagnostic, /舉牌服務扣款：100/);
    assert.match(diagnostic, /業績總額：1700/);
    assert.match(diagnostic, /舉牌\*/);
    const workbook = await bot.buildMonthlyWorkbook('placard-group', 11, 2026);
    const files = unzipSync(new Uint8Array(workbook));
    const sheet1 = strFromU8(files['xl/worksheets/sheet1.xml']);
    const sheet2 = strFromU8(files['xl/worksheets/sheet2.xml']);
    assert.match(sheet1, /舉牌服務扣款/);
    assert.match(sheet1, />100</);
    assert.match(sheet1, />1700</);
    assert.match(sheet2, /舉牌\*/);
  } finally {
    bot.__setOrdersCollectionForTests(null);
  }
});
