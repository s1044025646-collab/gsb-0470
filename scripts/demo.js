// 演示：单排两种固定方式 + 两排串联
const { GearStore } = require('../dist/store');

function show(title, store) {
  const r = store.solve();
  console.log(`\n== ${title} ==`);
  console.log('状态:', r.status, '秩:', r.rank, '自由度:', r.freeCols.length);
  if (r.solution) {
    r.axes.forEach((a, i) => console.log(`  ${a} = ${r.solution[i].toString()} rpm (${r.solution[i].toDecimal()})`));
  }
}

const s1 = new GearStore(':memory:');
['S', 'R', 'C'].forEach((a) => s1.addAxis(a));
s1.addRow({ Ns: 20, Nr: 60, sun: 'S', ring: 'R', carrier: 'C' });
s1.addFixed('S', '1200');
s1.addFixed('R', '0');
show('Ns=20 Nr=60, 太阳轮1200, 齿圈固定', s1);

const s2 = new GearStore(':memory:');
['S', 'R', 'C'].forEach((a) => s2.addAxis(a));
s2.addRow({ Ns: 20, Nr: 60, sun: 'S', ring: 'R', carrier: 'C' });
s2.addFixed('S', '1200');
s2.addFixed('C', '0');
show('Ns=20 Nr=60, 太阳轮1200, 行星架固定', s2);

const s3 = new GearStore(':memory:');
['S1', 'R1', 'C1S2', 'R2', 'C2'].forEach((a) => s3.addAxis(a));
s3.addRow({ Ns: 20, Nr: 60, sun: 'S1', ring: 'R1', carrier: 'C1S2' });
s3.addRow({ Ns: 20, Nr: 60, sun: 'C1S2', ring: 'R2', carrier: 'C2' });
s3.addFixed('S1', '1200');
s3.addFixed('R1', '0');
s3.addFixed('R2', '0');
show('两排串联（第一排行星架=第二排太阳轮）', s3);
