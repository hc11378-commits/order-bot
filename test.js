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

test('實際缺單 CUG338169 含彎引號與附加司機資料仍可完整辨識', () => {
  const text = [
    '“休旅接機-J',
    'CUG338169',
    '出發日期:9/10',
    '乘車人數:2',
    '行李數量:',
    '航班編號:CI52【05:40】',
    '上車地點:桃園機場',
    '下車地點:台灣台北市中山區新福里(民權東路二段63號)',
    '其他備註:',
    '聯絡人:TEST CUSTOMER',
    '電話:0900000000',
    '結算價704.00"',
    '',
    '姓名:測試司機',
    '電話:0900000000',
    '車號:TEST-0001',
    '車型:Toyota Rav4(白色',
  ].join('\n');
  const orders = bot.parseOrders(text);
  assert.equal(orders.length, 1);
  assert.deepEqual({
    orderId: orders[0].orderId, date: bot.normalizeDate(orders[0].date),
    time: orders[0].time, type: orders[0].type, loc: orders[0].loc,
    pax: orders[0].pax, price: orders[0].price,
  }, {
    orderId: 'CUG338169', date: '9/10', time: '05:40', type: '接',
    loc: '台北市中山區', pax: 2, price: 704,
  });
});

test('實際發哥單只有客收1100、無結算價與無英數編號仍計為一趟', () => {
  const text = [
    '"經五接機', '發哥單', '出發日期：9/10', '乘車人數：1-2', '行李數量：',
    '航班編號：JX803 【19:00】', '上車地點：桃園機場',
    '下車地點：板橋區合安一路77號9樓之2', '其他備註：', '',
    '聯絡人：測試小姐', '電話：0900000000', '★客收1100"', '',
    '司機姓名：測試司機', '電話：0900000000', '車型：KIA Carnival (白色)', '車號：TEST-0002.',
  ].join('\n');
  const orders = bot.parseOrders(text);
  assert.equal(orders.length, 1);
  assert.deepEqual({
    orderId: orders[0].orderId, date: bot.normalizeDate(orders[0].date),
    time: orders[0].time, type: orders[0].type, loc: orders[0].loc,
    pax: orders[0].pax, price: orders[0].price, remarks: orders[0].remarks,
  }, {
    orderId: null, date: '9/10', time: '19:00', type: '接',
    loc: '新北市板橋區', pax: '1-2', price: null, remarks: ['客收1100'],
  });
});

test('一般營運備註可保留，且不會把後續姓名電話當成備註', () => {
  const [order] = bot.parseOrders([
    '休旅接機', 'NOTE0001', '出發日期:9/10', '乘車人數:1',
    '航班編號:CI52【05:40】', '上車地點:桃園機場', '下車地點:台北市中山區',
    '其他備註:需輪椅協助', '聯絡人:王先生', '電話:0900000000', '結算價704',
  ].join('\n'));
  assert.deepEqual(order.remarks, ['需輪椅協助']);
  assert.doesNotMatch(order.remarks.join(','), /0900000000|王先生/);
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
  assert.equal(bot.normalizeDate(null), null);
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

test('沒有訂單編號的相同趟次使用 LINE 訊息 ID 區分，webhook 重送仍保持同一筆', () => {
  const order = { orderId: null, time: '08:00', price: 700, loc: '台北市中山區' };
  assert.notEqual(
    bot.getOrderStorageKey(order, 'message-1', 0),
    bot.getOrderStorageKey(order, 'message-2', 0)
  );
  assert.equal(
    bot.getOrderStorageKey(order, 'message-1', 0),
    bot.getOrderStorageKey(order, 'message-1', 0)
  );
});

test('舊資料若有相同群組日期及 key 的重複紀錄，只保留最新一筆', () => {
  const records = bot.dedupeOrderRecords([
    { groupId: 'g', serviceYear: 2026, date: '9/10', key: 'DUP0001', price: 700, updatedAt: new Date('2026-09-08T01:00:00Z') },
    { groupId: 'g', serviceYear: 2026, date: '9/10', key: 'DUP0001', price: 750, updatedAt: new Date('2026-09-08T02:00:00Z') },
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].price, 750);
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
    assert.match(summary, new RegExp(`結算價合計：${1000 + index}`));
    assert.match(summary, new RegExp(`客收合計：0`));
    assert.match(summary, new RegExp(`業績合計：${1000 + index}$`));
  }
});

test('摘要依時間排序並正確計算小數金額及備註', () => {
  const orders = {
    late: { time: '15:20', type: '接', loc: '台北市北投區', pax: 1, price: 750.5, remarks: ['客收200'] },
    early: { time: '00:10', type: '接', loc: '新北市土城區', pax: 2, price: 866, remarks: ['安椅'] },
  };
  const summary = bot.buildSummary('summary-group', '9/7', orders);
  assert.ok(summary.indexOf('00:10') < summary.indexOf('15:20'));
  assert.match(summary, /結算價合計：1616\.5/);
  assert.match(summary, /客收合計：200/);
  assert.match(summary, /業績合計：1816\.5/);
  assert.match(summary, /其他備註統計：安椅\*1/);
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

test('同訂單編號改日期時先寫入新單，再排除舊日期避免月結重複', async () => {
  const calls = [];
  bot.__setOrdersCollectionForTests({
    async updateOne(filter) { calls.push({ method: 'updateOne', filter }); },
    async updateMany(filter) { calls.push({ method: 'updateMany', filter }); },
  });
  const saved = await bot.saveOrderToMongo('date-change-group', '9/11', 'MOVE0001', {
    orderId: 'MOVE0001', date: '2026/9/11', time: '08:00', price: 700,
  });
  assert.equal(saved, true);
  assert.equal(calls[0].method, 'updateOne');
  assert.deepEqual(calls[0].filter, {
    groupId: 'date-change-group', serviceYear: 2026, date: '9/11', key: 'MOVE0001',
  });
  assert.equal(calls[1].method, 'updateMany');
  assert.equal(calls[1].filter.groupId, 'date-change-group');
  assert.equal(calls[1].filter.key, 'MOVE0001');
  assert.equal(calls[1].filter.cancelled, false);
});

test('同訂單編號重貼改單與新備註時只更新原紀錄，不增加趟數', async () => {
  const records = [];
  bot.__setOrdersCollectionForTests({
    async updateOne(filter, update) {
      const index = records.findIndex(record => record.groupId === filter.groupId &&
        record.serviceYear === filter.serviceYear && record.date === filter.date && record.key === filter.key);
      if (index >= 0) records[index] = { ...records[index], ...update.$set };
      else records.push({ ...update.$set });
    },
    async updateMany() {},
  });
  await bot.saveOrderToMongo('update-group', '9/10', 'UPD00001', {
    orderId: 'UPD00001', date: '2026/9/10', time: '08:00', price: 700, remarks: [],
  });
  await bot.saveOrderToMongo('update-group', '9/10', 'UPD00001', {
    orderId: 'UPD00001', date: '2026/9/10', time: '08:30', price: 750, remarks: ['需輪椅協助'],
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].time, '08:30');
  assert.equal(records[0].price, 750);
  assert.deepEqual(records[0].remarks, ['需輪椅協助']);
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

test('月結只查指定群組年月，並分開結算價、客收與業績', async () => {
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
  assert.match(report, /總趟數：3 趟/);
  assert.match(report, /結算價總額：11832\+待確認/);
  assert.match(report, /客收總額：200（共1筆）/);
  assert.match(report, /業績總額：12032\+待確認/);
  assert.match(report, /平均每趟業績：4010\.7\+待確認/);
});

test('月結將待確認結算價訂單計入趟數，並把已知客收納入業績', async () => {
  bot.__setOrdersCollectionForTests({
    find() {
      return { async toArray() { return [
        { key: 'KNOWN001', serviceYear: 2026, date: '9/10', price: 500, remarks: [] },
        { key: 'PENDING1', serviceYear: 2026, date: '9/10', price: null, remarks: ['客收1100'] },
      ]; } };
    },
  });
  const report = await bot.buildMonthlyReport('pending-month-group', 9, 2026);
  assert.match(report, /總趟數：2 趟/);
  assert.match(report, /結算價總額：500\+待確認/);
  assert.match(report, /客收總額：1100（共1筆）/);
  assert.match(report, /業績總額：1600\+待確認/);
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
    }, now, '9/10'));
  }
  assert.deepEqual(queriedGroups, ['actual-group-1', 'actual-group-2', 'actual-group-3']);
  const codes = reports.map(report => report.match(/群組代碼：(\w+)/)[1]);
  assert.equal(new Set(codes).size, 3);
  assert.match(reports[0], /執行時間：9\/10 12:00/);
  assert.match(reports[0], /檢查服務日：9\/10/);
  assert.match(reports[0], /結算價總額：701/);
  assert.match(reports[0], /業績總額：701/);
  assert.doesNotMatch(reports[0], /703/);
});

test('執行日9/8可明確診斷9/10預派單，且查詢不會離開當前群組', async () => {
  let capturedQuery;
  bot.__setOrdersCollectionForTests({
    find(query) {
      capturedQuery = query;
      return {
        sort() { return this; },
        async toArray() {
          return [{ time: '08:30', type: '送', loc: '新北市板橋區', price: 665, senderKey: 'sender-a' }];
        },
      };
    },
  });
  const report = await bot.buildGroupDiagnostic(
    'future-service-group',
    { senderId: 'future-user', conversationType: 'group' },
    new Date('2026-09-08T10:00:00.000Z'),
    '9/10'
  );
  assert.deepEqual(capturedQuery, {
    groupId: 'future-service-group', serviceYear: 2026, date: '9/10', cancelled: false,
  });
  assert.match(report, /執行時間：9\/8 18:00/);
  assert.match(report, /檢查服務日：9\/10/);
  assert.match(report, /服務日訂單：/);
  assert.match(report, /新北市板橋區送/);
});

test('群組診斷將結算價與客收分開，業績為兩者相加', async () => {
  bot.__setOrdersCollectionForTests({
    find() {
      return {
        sort() { return this; },
        async toArray() { return [
          { key: 'PERF0001', groupId: 'performance-group', serviceYear: 2026, date: '9/10', time: '08:00', type: '接', loc: '台北市中山區', price: 700, remarks: ['客收200'] },
          { key: 'PERF0002', groupId: 'performance-group', serviceYear: 2026, date: '9/10', time: '09:00', type: '送', loc: '新北市板橋區', price: null, remarks: ['客收1100'] },
        ]; },
      };
    },
  });
  const report = await bot.buildGroupDiagnostic(
    'performance-group', { senderId: 'user', conversationType: 'group' },
    new Date('2026-09-08T10:00:00.000Z'), '9/10'
  );
  assert.match(report, /MongoDB有效訂單：2 筆/);
  assert.match(report, /結算價總額：700/);
  assert.match(report, /客收總額：1300/);
  assert.match(report, /業績總額：2000\+待確認/);
  assert.match(report, /待確認金額：1 筆/);
});

test('群組診斷未指定日期時，只從該群組自動找最近服務日', async () => {
  const queries = [];
  bot.__setOrdersCollectionForTests({
    find(query) {
      queries.push(query);
      if (queries.length === 1) {
        return {
          sort() { return this; }, limit() { return this; },
          async toArray() { return [{ date: '9/10', serviceYear: 2026, updatedAt: new Date() }]; },
        };
      }
      return {
        sort() { return this; },
        async toArray() { return [{ time: '02:15', type: '接', loc: '新北市中和區', price: 637 }]; },
      };
    },
  });
  const report = await bot.buildGroupDiagnostic(
    'auto-latest-group',
    { senderId: 'auto-user', conversationType: 'group' },
    new Date('2026-09-08T10:00:00.000Z')
  );
  assert.deepEqual(queries[0], { groupId: 'auto-latest-group', cancelled: false });
  assert.deepEqual(queries[1], {
    groupId: 'auto-latest-group', serviceYear: 2026, date: '9/10', cancelled: false,
  });
  assert.match(report, /執行時間：9\/8 18:00/);
  assert.match(report, /檢查服務日：9\/10/);
});

test('群組診斷的無效服務日會安全停止且不查詢資料庫', async () => {
  let databaseCalled = false;
  bot.__setOrdersCollectionForTests({
    find() { databaseCalled = true; throw new Error('不應執行'); },
  });
  const report = await bot.buildGroupDiagnostic(
    'invalid-date-group',
    { senderId: 'invalid-user', conversationType: 'group' },
    new Date('2026-09-08T10:00:00.000Z'),
    '13/40'
  );
  assert.match(report, /不是有效日期/);
  assert.match(report, /沒有修改任何資料/);
  assert.equal(databaseCalled, false);
});

test('webhook 可接收「群組診斷 9/10」並只回覆該群組的服務日資料', async () => {
  let capturedQuery;
  bot.__setOrdersCollectionForTests({
    find(query) {
      capturedQuery = query;
      return {
        sort() { return this; },
        async toArray() {
          return [{ time: '15:20', type: '接', loc: '台北市北投區', price: 750 }];
        },
      };
    },
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
    type: 'message', replyToken: 'diagnostic-reply',
    source: { type: 'group', groupId: 'diagnostic-command-group', userId: 'diagnostic-user' },
    message: { type: 'text', id: 'diagnostic-message', text: '群組診斷 9/10' },
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
    assert.equal(capturedQuery.groupId, 'diagnostic-command-group');
    assert.equal(capturedQuery.date, '9/10');
    assert.match(replyText, /檢查服務日：9\/10/);
    assert.match(replyText, /接台北市北投區/);
  } finally {
    axios.post = originalPost;
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
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
  assert.match(result, /結算價總額：5718/);
  assert.match(result, /業績總額：5718/);
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
    find() {
      return {
        sort() { return this; },
        async toArray() { return mongoWrite ? [mongoWrite.update.$set] : []; },
      };
    },
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

test('重啟後只補貼 CUG338169 一次，Bot 即從 MongoDB 同步完整九筆與總額6253', async () => {
  const groupId = 'missing-order-group';
  const records = [
    ['A0000001','00:10','接','新北市永和區',803],
    ['A0000002','02:00','接','台北市萬華區',813],
    ['A0000003','05:00','送','台北市中正區',850],
    ['A0000004','09:00','送','台北市松山區',650],
    ['A0000005','10:25','接','台北市信義區',684],
    ['A0000006','12:30','送','台北市大安區',530],
    ['A0000007','13:20','接','台北市中正區',684],
    ['A0000008','16:00','送','台北市內湖區',535],
  ].map(([key,time,type,loc,price], index) => ({
    groupId, serviceYear: 2026, date: '9/10', key, orderId: key,
    time, type, loc, price, pax: 1, remarks: [], cancelled: false,
    updatedAt: new Date(`2026-09-08T0${index}:00:00.000Z`),
  }));

  bot.__setOrdersCollectionForTests({
    async updateOne(filter, update) {
      const index = records.findIndex(record => record.groupId === filter.groupId &&
        record.serviceYear === filter.serviceYear && record.date === filter.date && record.key === filter.key);
      if (index >= 0) records[index] = { ...records[index], ...update.$set };
      else records.push({ ...update.$set });
    },
    async updateMany() {},
    find(query) {
      const matched = records.filter(record => record.groupId === query.groupId &&
        record.serviceYear === query.serviceYear && record.date === query.date &&
        record.cancelled === query.cancelled);
      return {
        sort() { return this; },
        async toArray() { return matched; },
      };
    },
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
  const orderText = [
    '“休旅接機-J', 'CUG338169', '出發日期:9/10', '乘車人數:2', '行李數量:',
    '航班編號:CI52【05:40】', '上車地點:桃園機場',
    '下車地點:台灣台北市中山區新福里(民權東路二段63號)',
    '其他備註:', '聯絡人:測試', '電話:0900000000', '結算價704.00"',
    '', '姓名:測試司機', '電話:0900000000', '車號:TEST-0001', '車型:Toyota Rav4(白色',
  ].join('\n');
  const body = JSON.stringify({ events: [{
    type: 'message', replyToken: 'missing-order-reply',
    source: { type: 'group', groupId, userId: 'dispatcher-user' },
    message: { type: 'text', id: 'missing-order-message', text: orderText },
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
    assert.equal(records.filter(record => !record.cancelled).length, 9);
    assert.match(replyText, /1。00:10/);
    assert.match(replyText, /3。05:00/);
    assert.match(replyText, /4。05:40，接台北市中山區/);
    assert.match(replyText, /9。16:00/);
    assert.match(replyText, /結算價合計：6253/);
    assert.match(replyText, /客收合計：0/);
    assert.match(replyText, /業績合計：6253$/m);
  } finally {
    axios.post = originalPost;
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});

test('重啟後只補貼發哥單一次，Bot 即回覆完整八趟、已確認5206及客收1100', async () => {
  const groupId = 'customer-collection-group';
  const records = [
    ['B0000001','08:30','送','台北市士林區',670],
    ['B0000002','09:00','接','台北市萬華區',995],
    ['B0000003','12:00','送','台北市萬華區',633],
    ['B0000004','12:35','接','台北市士林區',885],
    ['B0000005','15:10','送','台北市士林區',535],
    ['B0000006','15:45','接','新北市蘆洲區',895],
    ['B0000007','18:30','送','台北市中正區',593],
  ].map(([key,time,type,loc,price], index) => ({
    groupId, serviceYear: 2026, date: '9/10', key, orderId: key,
    time, type, loc, price, pax: 1, remarks: [], cancelled: false,
    updatedAt: new Date(`2026-09-08T0${index}:00:00.000Z`),
  }));
  bot.__setOrdersCollectionForTests({
    async updateOne(filter, update) {
      const index = records.findIndex(record => record.groupId === filter.groupId &&
        record.serviceYear === filter.serviceYear && record.date === filter.date && record.key === filter.key);
      if (index >= 0) records[index] = { ...records[index], ...update.$set };
      else records.push({ ...update.$set });
    },
    async updateMany() {},
    find(query) {
      const matched = records.filter(record => record.groupId === query.groupId &&
        record.serviceYear === query.serviceYear && record.date === query.date &&
        record.cancelled === query.cancelled);
      return { sort() { return this; }, async toArray() { return matched; } };
    },
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
  const orderText = [
    '"經五接機', '發哥單', '出發日期：9/10', '乘車人數：1-2', '行李數量：',
    '航班編號：JX803 【19:00】', '上車地點：桃園機場',
    '下車地點：板橋區合安一路77號9樓之2', '其他備註：', '',
    '聯絡人：測試', '電話：0900000000', '★客收1100"', '',
    '司機姓名：測試司機', '電話：0900000000', '車型：KIA Carnival (白色)', '車號：TEST-0002.',
  ].join('\n');
  const body = JSON.stringify({ events: [{
    type: 'message', replyToken: 'collection-reply',
    source: { type: 'group', groupId, userId: 'dispatcher-user' },
    message: { type: 'text', id: 'customer-collection-message', text: orderText },
  }] });
  const signature = crypto.createHmac('sha256', process.env.LINE_CHANNEL_SECRET)
    .update(Buffer.from(body)).digest('base64');
  try {
    const response = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-line-signature': signature }, body,
    });
    assert.equal(response.status, 200);
    assert.equal(records.filter(record => !record.cancelled).length, 8);
    assert.match(replyText, /8。19:00，接新北市板橋區/);
    assert.match(replyText, /待確認金額/);
    assert.match(replyText, /結算價合計：5206\+待確認/);
    assert.match(replyText, /客收合計：1100/);
    assert.match(replyText, /業績合計：6306\+待確認$/m);
  } finally {
    axios.post = originalPost;
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});

test('MongoDB 寫入失敗時不回覆虛假成功簡表', async () => {
  bot.__setOrdersCollectionForTests({
    async updateOne() { throw new Error('simulated database failure'); },
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
  const orderText = [
    '五座接機', 'FAIL0001', '出發日期：2026/09/10 06:30',
    '上車地點：桃園機場', '下車地點：新北市土城區', '乘車人數：2', '結算價：866',
  ].join('\n');
  const body = JSON.stringify({ events: [{
    type: 'message', replyToken: 'failure-reply', source: { type: 'group', groupId: 'failure-group', userId: 'user' },
    message: { type: 'text', id: 'failure-message', text: orderText },
  }] });
  const signature = crypto.createHmac('sha256', process.env.LINE_CHANNEL_SECRET)
    .update(Buffer.from(body)).digest('base64');
  try {
    const response = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-line-signature': signature }, body,
    });
    assert.equal(response.status, 200);
    assert.match(replyText, /訂單儲存失敗/);
    assert.doesNotMatch(replyText, /業績合計：866/);
  } finally {
    axios.post = originalPost;
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});

test('缺少服務日的預派單不會被誤存成執行當天', async () => {
  let databaseWriteCalled = false;
  bot.__setOrdersCollectionForTests({
    async updateOne() { databaseWriteCalled = true; },
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
  const orderText = [
    '五座接機', 'NODATE01', '乘車人數：2', '航班編號：CI52【05:40】',
    '上車地點：桃園機場', '下車地點：新北市板橋區', '結算價：704',
  ].join('\n');
  const body = JSON.stringify({ events: [{
    type: 'message', replyToken: 'no-date-reply', source: { type: 'group', groupId: 'no-date-group', userId: 'user' },
    message: { type: 'text', id: 'no-date-message', text: orderText },
  }] });
  const signature = crypto.createHmac('sha256', process.env.LINE_CHANNEL_SECRET)
    .update(Buffer.from(body)).digest('base64');
  try {
    const response = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-line-signature': signature }, body,
    });
    assert.equal(response.status, 200);
    assert.equal(databaseWriteCalled, false);
    assert.match(replyText, /訂單格式無法完整辨識/);
  } finally {
    axios.post = originalPost;
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});

test('最後一筆訂單取消後仍明確回覆零筆，不會無反應', async () => {
  const record = {
    groupId: 'cancel-last-group', serviceYear: 2026, date: '9/10', key: 'CANCEL01', orderId: 'CANCEL01',
    time: '08:00', type: '接', loc: '台北市中山區', price: 700, pax: 1, remarks: [], cancelled: false,
  };
  bot.__setOrdersCollectionForTests({
    async findOne() { return record.cancelled ? null : record; },
    async updateOne(filter, update) {
      if (filter.groupId === record.groupId && filter.key === record.key) Object.assign(record, update.$set);
    },
    find(query) {
      const matched = !record.cancelled && query.groupId === record.groupId ? [record] : [];
      return { sort() { return this; }, async toArray() { return matched; } };
    },
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
    type: 'message', replyToken: 'cancel-last-reply', source: { type: 'group', groupId: record.groupId, userId: 'user' },
    message: { type: 'text', id: 'cancel-last-message', text: 'CANCEL01 取消' },
  }] });
  const signature = crypto.createHmac('sha256', process.env.LINE_CHANNEL_SECRET)
    .update(Buffer.from(body)).digest('base64');
  try {
    const response = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-line-signature': signature }, body,
    });
    assert.equal(response.status, 200);
    assert.equal(record.cancelled, true);
    assert.match(replyText, /目前無有效訂單/);
    assert.match(replyText, /結算價合計：0/);
    assert.match(replyText, /客收合計：0/);
    assert.match(replyText, /業績合計：0/);
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
