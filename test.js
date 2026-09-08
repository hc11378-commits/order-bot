process.env.NODE_ENV = 'test';
process.env.LINE_CHANNEL_SECRET = 'automated-test-secret';
process.env.LINE_CHANNEL_ACCESS_TOKEN = 'automated-test-token';
process.env.MONGO_URI = 'mongodb://not-used-during-tests';
process.env.TEST_MODE = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const axios = require('axios');
const bot = require('./index');

test('全台行政區資料包含 22 縣市及 368 個鄉鎮市區', () => {
  assert.equal(Object.keys(bot.REGIONS_BY_CITY).length, 22);
  assert.equal(Object.values(bot.REGIONS_BY_CITY).flat().length, 368);
});

const addressCases = [
  ['臺北市中正區忠孝西路', '台北市中正區'],
  ['新北市土城區中央路', '新北市土城區'],
  ['土城區中央路', '新北市土城區'],
  ['桃園市蘆竹區南山路', '桃園市蘆竹區'],
  ['新竹市香山區中華路', '新竹市香山區'],
  ['新竹縣竹北市光明六路', '新竹縣竹北市'],
  ['苗栗縣頭份市中央路', '苗栗縣頭份市'],
  ['臺中市西屯區台灣大道', '台中市西屯區'],
  ['彰化縣員林市中山路', '彰化縣員林市'],
  ['南投縣仁愛鄉大同村', '南投縣仁愛鄉'],
  ['雲林縣麥寮鄉中興路', '雲林縣麥寮鄉'],
  ['嘉義市東區中山路', '嘉義市東區'],
  ['嘉義縣民雄鄉建國路', '嘉義縣民雄鄉'],
  ['臺南市中西區民生路', '台南市中西區'],
  ['高雄市左營區博愛路', '高雄市左營區'],
  ['屏東縣三地門鄉中正路', '屏東縣三地門鄉'],
  ['宜蘭縣羅東鎮公正路', '宜蘭縣羅東鎮'],
  ['花蓮縣吉安鄉中央路', '花蓮縣吉安鄉'],
  ['臺東縣池上鄉中山路', '台東縣池上鄉'],
  ['澎湖縣馬公市中正路', '澎湖縣馬公市'],
  ['金門縣金城鎮民生路', '金門縣金城鎮'],
  ['連江縣南竿鄉介壽村', '連江縣南竿鄉'],
];

for (const [address, expected] of addressCases) {
  test(`地址辨識：${address}`, () => {
    assert.equal(bot.parseAddr(address), expected);
  });
}

test('同名行政區缺少縣市時不武斷猜測', () => {
  assert.equal(bot.parseAddr('中正區某路100號'), '縣市待確認：中正區');
  assert.equal(bot.parseAddr('信義區某路100號'), '縣市待確認：信義區');
});

test('機場本身不會被當成接送目的地行政區', () => {
  assert.equal(bot.parseAddr('桃園機場第一航廈'), null);
  assert.equal(bot.parseAddr('松山機場'), null);
});

test('不明交通趟地址會明確標示待確認', () => {
  assert.match(bot.parseAddrNoDefault('某某飯店大門口'), /^地址待確認：/);
});

test('一般接機訂單解析正確', () => {
  const text = [
    '五座接機',
    'ABC12345',
    '出發日期：2026/09/07 02:15',
    '上車地點：桃園機場第一航廈',
    '下車地點：新北市中和區中山路',
    '乘車人數：1',
    '其他備註：舉牌',
    '結算價：637',
  ].join('\n');
  const [order] = bot.parseOrders(text);
  assert.deepEqual(
    { orderId: order.orderId, time: order.time, type: order.type, loc: order.loc,
      pax: order.pax, price: order.price, date: order.date, remarks: order.remarks },
    { orderId: 'ABC12345', time: '02:15', type: '接', loc: '新北市中和區',
      pax: 1, price: 637, date: '2026/09/07', remarks: ['舉牌'] }
  );
});

test('一般送機訂單解析正確', () => {
  const text = [
    '五座送機',
    'XYZ98765',
    '出發日期：2026/9/7 08:30',
    '上車地點：新北市板橋區文化路',
    '下車地點：桃園機場第二航廈',
    '乘車人數：2',
    '結算價：665',
  ].join('\n');
  const [order] = bot.parseOrders(text);
  assert.equal(order.type, '送');
  assert.equal(order.loc, '新北市板橋區');
  assert.equal(order.price, 665);
});

test('同一則訊息的兩筆訂單都能拆分且不重複', () => {
  const text = [
    '五座接機', 'AAA11111', '出發日期：2026/9/8 01:00',
    '上車地點：桃園機場', '下車地點：台北市萬華區',
    '乘車人數：1', '結算價：700',
    '五座送機', 'BBB22222', '出發日期：2026/9/8 03:00',
    '上車地點：新北市新店區', '下車地點：桃園機場',
    '乘車人數：2', '結算價：800',
  ].join('\n');
  const orders = bot.parseOrders(text);
  assert.equal(orders.length, 2);
  assert.deepEqual(orders.map(order => order.orderId), ['AAA11111', 'BBB22222']);
});

test('駕駛回報格式保留服務日期', () => {
  const order = bot.parseDriverReportOrder([
    '送機_桃園機場',
    '時間：2026/09/12_05:30',
    '貴賓：王先生',
    '地址：台北市北投區中央北路',
    '人數行李：2位',
    '備註：-',
  ].join('\n'));
  assert.equal(order.date, '2026/09/12');
  assert.equal(order.time, '05:30');
  assert.equal(order.loc, '台北市北投區');
  assert.equal(order.type, '送');
});

test('交通趟顯示起訖縣市行政區', () => {
  const order = bot.parseTransferOrder([
    '用車日期：2026/9/10',
    '出發時間：07:40',
    '搭車地區：桃園市蘆竹區',
    '下車地區：台北市中山區',
    '乘車人數：3人',
    '需付車資：1,200',
  ].join('\n'));
  assert.equal(order.loc, '桃園市蘆竹區→台北市中山區');
});

test('日期一律正規化為 M/D', () => {
  assert.equal(bot.normalizeDate('2026-09-07'), '9/7');
  assert.equal(bot.normalizeDate('2026/09/07'), '9/7');
  assert.equal(bot.normalizeDate('09/07'), '9/7');
  assert.equal(bot.normalizeDate('2026/02/29'), null);
  assert.equal(bot.normalizeDate('13/40'), null);
  assert.equal(bot.normalizeDate('日期不明'), null);
});

test('完整日期可取出服務年份', () => {
  assert.equal(bot.extractServiceYear('2027/01/02'), 2027);
  assert.equal(bot.extractServiceYear('2025-12-31'), 2025);
});

test('台灣跨日時刻不受 Render 的 UTC 時區影響', () => {
  const utc = new Date('2026-09-07T16:30:00.000Z');
  assert.deepEqual(bot.getBusinessDateParts(utc), {
    year: 2026, month: 9, day: 8, hour: 0, minute: 30,
  });
  assert.equal(bot.getTodayStr(utc), '9/8');
});

test('月份指令解析範圍正確', () => {
  assert.equal(bot.parseMonthCommand('月結 9月'), 9);
  assert.equal(bot.parseMonthCommand('月結9'), 9);
  assert.equal(bot.parseMonthCommand('月結13月'), null);
  assert.equal(bot.parseMonthCommand('查月結'), null);
});

test('不同 LINE 群組的同日訂單完全隔離', () => {
  const groupA = bot.getDateOrders('group-A', '9/7', true);
  const groupB = bot.getDateOrders('group-B', '9/7', true);
  groupA.A = { time: '01:00', type: '接', loc: '台北市中正區', pax: 1, price: 700, remarks: [] };
  groupB.B = { time: '02:00', type: '送', loc: '新北市板橋區', pax: 2, price: 800, remarks: [] };
  const summaryA = bot.buildSummary('group-A', '9/7', groupA);
  const summaryB = bot.buildSummary('group-B', '9/7', groupB);
  assert.match(summaryA, /700/);
  assert.doesNotMatch(summaryA, /800/);
  assert.match(summaryB, /800/);
  assert.doesNotMatch(summaryB, /700/);
});

test('同群組事件依序處理、不同群組可同時處理', async () => {
  const releaseFirst = await bot.acquireSourceQueue('queue-A');
  let secondAcquired = false;
  const second = bot.acquireSourceQueue('queue-A').then(release => {
    secondAcquired = true;
    return release;
  });
  const releaseOtherGroup = await bot.acquireSourceQueue('queue-B');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(secondAcquired, false);
  releaseOtherGroup();
  releaseFirst();
  const releaseSecond = await second;
  assert.equal(secondAcquired, true);
  releaseSecond();
});

test('模擬 35 個司機群組的資料不會互相混入摘要', () => {
  for (let index = 1; index <= 35; index++) {
    const groupId = `driver-group-${index}`;
    const orders = bot.getDateOrders(groupId, '9/20', true);
    orders[`ORDER-${index}`] = {
      time: '10:00', type: '接', loc: '新北市板橋區', pax: 1,
      price: 1000 + index, remarks: [],
    };
  }
  for (let index = 1; index <= 35; index++) {
    const groupId = `driver-group-${index}`;
    const summary = bot.buildSummary(groupId, '9/20', bot.getDateOrders(groupId, '9/20'));
    assert.match(summary, new RegExp(`結：${1000 + index}$`));
  }
});

test('摘要依時間排序並正確計算小數金額及備註', () => {
  const orders = {
    late: { time: '15:20', type: '接', loc: '台北市北投區', pax: 1, price: 750.5, remarks: ['客收200'] },
    early: { time: '00:10', type: '接', loc: '新北市土城區', pax: 2, price: 866, remarks: ['安椅'] },
  };
  const summary = bot.buildSummary('summary-group', '9/7', orders);
  assert.ok(summary.indexOf('00:10') < summary.indexOf('15:20'));
  assert.match(summary, /結：1616\.5，客收200、安椅\*1/);
});

test('LINE webhook 簽章使用原始內容驗證', () => {
  const rawBody = Buffer.from(JSON.stringify({ events: [] }));
  const signature = crypto.createHmac('sha256', process.env.LINE_CHANNEL_SECRET)
    .update(rawBody).digest('base64');
  assert.equal(bot.verifySignature({ rawBody, headers: { 'x-line-signature': signature } }), true);
  assert.equal(bot.verifySignature({ rawBody, headers: { 'x-line-signature': 'invalid' } }), false);
});

test('超長 LINE 摘要會安全分段且每段不超過限制', () => {
  const text = Array.from({ length: 300 }, (_, index) => `${index + 1}。這是一筆很長的測試訂單內容`).join('\n');
  const messages = bot.toLineMessages(text);
  assert.ok(messages.length > 1 && messages.length <= 5);
  assert.ok(messages.every(message => message.type === 'text' && message.text.length <= 4900));
});

test('MongoDB 寫入使用正規化日期且不會被原始日期覆蓋', async () => {
  let captured;
  bot.__setOrdersCollectionForTests({
    async updateOne(filter, update, options) { captured = { filter, update, options }; },
  });
  await bot.saveOrderToMongo('group-save', '09/07', 'ORDER001', {
    orderId: 'ORDER001', date: '2026/09/07', time: '08:00', price: 700,
  });
  assert.deepEqual(captured.filter, {
    groupId: 'group-save', serviceYear: 2026, date: '9/7', key: 'ORDER001',
  });
  assert.equal(captured.update.$set.date, '9/7');
  assert.equal(captured.update.$set.serviceYear, 2026);
  assert.equal(captured.update.$set.cancelled, false);
  assert.equal(captured.options.upsert, true);
});

test('部署重啟後仍可從 MongoDB 找回同群組訂單', async () => {
  bot.__setOrdersCollectionForTests({
    async findOne(query) {
      assert.equal(query.groupId, 'restart-group');
      return {
        _id: 'mongo-1', groupId: 'restart-group', key: 'RESTART01',
        orderId: 'RESTART01', date: '09/07', time: '08:00', price: 700,
        cancelled: false,
      };
    },
  });
  const found = await bot.findOrderDate('restart-group', 'RESTART01');
  assert.deepEqual(found, { date: '9/7', key: 'RESTART01' });
  assert.ok(bot.getDateOrders('restart-group', '9/7').RESTART01);
});

test('月結只統計指定群組、年份、月份、未取消且有數字金額的訂單', async () => {
  let capturedQuery;
  const records = [
    { date: '9/6', price: 6114, remarks: [] },
    { date: '9/7', price: 5718, remarks: ['客收200'] },
    { date: '9/7', price: null, remarks: [] },
  ];
  bot.__setOrdersCollectionForTests({
    find(query) {
      capturedQuery = query;
      return { async toArray() { return records; } };
    },
  });
  const report = await bot.buildMonthlyReport('monthly-group', 9, 2026);
  assert.equal(capturedQuery.groupId, 'monthly-group');
  assert.equal(capturedQuery.serviceYear, 2026);
  assert.equal(capturedQuery.cancelled, false);
  assert.match(report, /2026年9月結算報表/);
  assert.match(report, /總趟數：2 趟/);
  assert.match(report, /總金額：11832/);
  assert.match(report, /平均每趟：5916/);
  assert.match(report, /客收總額：200（共1筆）/);
});

test('三個實際群組會產生不同匿名代碼且診斷只查自己的 groupId', async () => {
  const queriedGroups = [];
  bot.__setOrdersCollectionForTests({
    find(query) {
      queriedGroups.push(query.groupId);
      const suffix = query.groupId.slice(-1);
      return {
        sort() { return this; },
        async toArray() {
          return [{ time: `0${suffix}:00`, type: '接', loc: '新北市板橋區', price: 700 + Number(suffix), senderKey: `sender-${suffix}` }];
        },
      };
    },
  });
  const now = new Date('2026-09-10T04:00:00.000Z');
  const reports = [];
  for (const groupId of ['actual-group-1', 'actual-group-2', 'actual-group-3']) {
    reports.push(await bot.buildGroupDiagnostic(groupId, {
      senderId: `user-${groupId}`, conversationType: 'group',
    }, now));
  }
  assert.deepEqual(queriedGroups, ['actual-group-1', 'actual-group-2', 'actual-group-3']);
  const codes = reports.map(report => report.match(/群組代碼：(\w+)/)[1]);
  assert.equal(new Set(codes).size, 3);
  assert.match(reports[0], /MongoDB金額：701/);
  assert.doesNotMatch(reports[0], /703/);
});

test('匿名識別碼固定且不同群組不會相同', () => {
  assert.equal(bot.anonymizeId('group-A'), bot.anonymizeId('group-A'));
  assert.notEqual(bot.anonymizeId('group-A'), bot.anonymizeId('group-B'));
  assert.equal(bot.anonymizeId('group-A').length, 10);
});

test('9/7 修正資料不完整時整批停止且不寫入', async () => {
  let bulkWriteCalled = false;
  bot.__setOrdersCollectionForTests({
    find() {
      return {
        sort() { return this; },
        async toArray() { return []; },
      };
    },
    async bulkWrite() { bulkWriteCalled = true; },
  });
  const result = await bot.repairSeptember7('repair-group');
  assert.match(result, /修正停止/);
  assert.equal(bulkWriteCalled, false);
});

test('9/7 修正完整吻合時只標記額外資料取消', async () => {
  const correct = [
    ['00:10','接','台北土城',2,866], ['02:15','接','新北中和',1,637],
    ['05:00','送','新北新店',1,983], ['08:30','送','新北板橋',1,665],
    ['10:30','送','台北萬華',4,650], ['11:00','接','台北中正',1,637],
    ['14:00','送','台北中正',1,530], ['15:20','接','台北北投',1,750],
  ].map((row, index) => ({
    _id: `keep-${index}`, date: '9/7', serviceYear: 2026, cancelled: false,
    time: row[0], type: row[1], loc: row[2], pax: row[3], price: row[4], remarks: [],
  }));
  const extra = {
    _id: 'extra-1', date: '9/7', serviceYear: 2026, cancelled: false,
    time: '18:00', type: '接', loc: '台北中山', pax: 1, price: 999, remarks: [],
  };
  let operations;
  let findCount = 0;
  bot.__setOrdersCollectionForTests({
    find() {
      findCount++;
      if (findCount === 1) {
        return { sort() { return this; }, async toArray() { return [...correct, extra]; } };
      }
      return { async toArray() { return correct; } };
    },
    async bulkWrite(value) { operations = value; },
  });
  const result = await bot.repairSeptember7('repair-group');
  assert.match(result, /9\/7 修正完成/);
  assert.match(result, /排除多餘紀錄：1 筆/);
  assert.match(result, /總趟數：8 趟/);
  assert.match(result, /總金額：5718/);
  const extraOperation = operations.find(operation => operation.updateOne.filter._id === 'extra-1');
  assert.equal(extraOperation.updateOne.update.$set.cancelled, true);
  assert.equal(operations.filter(operation => operation.updateOne.update.$set.cancelled === true).length, 1);
});

test('HTTP 健康檢查與 webhook 簽章防護正常', async () => {
  const server = bot.app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).databaseReady, true);

    const invalid = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"events":[]}',
    });
    assert.equal(invalid.status, 403);

    const body = '{"events":[]}';
    const signature = crypto.createHmac('sha256', process.env.LINE_CHANNEL_SECRET)
      .update(Buffer.from(body)).digest('base64');
    const valid = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-line-signature': signature },
      body,
    });
    assert.equal(valid.status, 200);
  } finally {
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});

test('完整 webhook 流程可接單、寫入 MongoDB 並用 Reply API 回覆', async () => {
  let mongoWrite;
  bot.__setOrdersCollectionForTests({
    async updateOne(filter, update, options) { mongoWrite = { filter, update, options }; },
  });
  const originalPost = axios.post;
  let lineReply;
  axios.post = async (url, payload) => { lineReply = { url, payload }; return { status: 200 }; };

  const server = bot.app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  const orderText = [
    '五座接機', 'LIVE1234', '出發日期：2026/09/21 06:30',
    '上車地點：桃園機場第一航廈', '下車地點：新北市土城區中央路',
    '乘車人數：2', '結算價：866',
  ].join('\n');
  const body = JSON.stringify({ events: [{
    type: 'message', webhookEventId: 'event-test-1', replyToken: 'reply-test-1',
    source: { type: 'group', groupId: 'live-group', userId: 'live-user-1' },
    message: { type: 'text', id: 'message-test-1', text: orderText },
  }] });
  const signature = crypto.createHmac('sha256', process.env.LINE_CHANNEL_SECRET)
    .update(Buffer.from(body)).digest('base64');

  try {
    const response = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-line-signature': signature },
      body,
    });
    assert.equal(response.status, 200);
    assert.equal(mongoWrite.filter.groupId, 'live-group');
    assert.equal(mongoWrite.filter.date, '9/21');
    assert.equal(mongoWrite.update.$set.loc, '新北市土城區');
    assert.equal(mongoWrite.update.$set.conversationType, 'group');
    assert.equal(mongoWrite.update.$set.senderKey.length, 10);
    assert.match(lineReply.url, /message\/reply$/);
    assert.match(lineReply.payload.messages[0].text, /接新北市土城區/);
  } finally {
    axios.post = originalPost;
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});

test('任意日期的舊式修正指令均會停止且不修改資料', async () => {
  let databaseWriteCalled = false;
  bot.__setOrdersCollectionForTests({
    async updateOne() { databaseWriteCalled = true; },
    async bulkWrite() { databaseWriteCalled = true; },
  });
  const originalPost = axios.post;
  let replyText = '';
  axios.post = async (_url, payload) => {
    replyText = payload.messages.map(message => message.text).join('\n');
    return { status: 200 };
  };
  const server = bot.app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  const body = JSON.stringify({ events: [{
    type: 'message', replyToken: 'repair-reply',
    source: { type: 'group', groupId: 'safe-group', userId: 'safe-user' },
    message: { type: 'text', id: 'repair-message', text: '修正9/10' },
  }] });
  const signature = crypto.createHmac('sha256', process.env.LINE_CHANNEL_SECRET)
    .update(Buffer.from(body)).digest('base64');
  try {
    const response = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-line-signature': signature },
      body,
    });
    assert.equal(response.status, 200);
    assert.match(replyText, /指令已停用/);
    assert.match(replyText, /沒有修改任何資料/);
    assert.equal(databaseWriteCalled, false);
  } finally {
    axios.post = originalPost;
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});
