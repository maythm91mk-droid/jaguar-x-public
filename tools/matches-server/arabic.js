// English (Latin) names → Arabic letters, by how they sound (Maytham's ask, 7 Nov 2026: names are written as they
// are said, never translated: «Al Hazm» had become «الله-حزم», «Elland Road» «طريق إلاند»).
// Used for any team, player, coach, referee or stadium that names.json doesn't have by hand.
'use strict';

const SUFFIX = /\b(f\.?c\.?|s\.?c\.?|s\.?f\.?c\.?|c\.?f\.?|a\.?f\.?c\.?|fk|sk|bk|cd|ud|sd|cp|club|calcio|ssd|ssc|as|ac|afc|sv|fsv|vfb|vfl|tsg|ii)\b/gi;

function plain(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ø/g, 'o').replace(/Ø/g, 'O').replace(/æ/g, 'ae').replace(/ß/g, 'ss').replace(/đ/g, 'd').replace(/ł/g, 'l')
    .replace(/ı/g, 'i');
}

/** A key for looking names up: lower case, no accents, no FC / SC…, no «al», letters only. */
function key(s) {
  return plain(s).toLowerCase().replace(SUFFIX, ' ').replace(/\b(saudi|club)\b/g, ' ')
    .replace(/\bal[\s-]+/g, 'al').replace(/[^a-z0-9]/g, '');
}

// Longest first.
const GROUPS = [
  ['tch', 'تش'], ['sch', 'ش'], ['dzh', 'ج'], ['zh', 'ج'], ['kh', 'خ'], ['gh', 'غ'], ['sh', 'ش'], ['ch', 'تش'],
  ['th', 'ث'], ['ph', 'ف'], ['ck', 'ك'], ['qu', 'كو'], ['dj', 'ج'], ['tz', 'تس'], ['ts', 'تس'], ['cz', 'تش'],
  ['sz', 'ش'], ['ou', 'و'], ['oo', 'و'], ['ee', 'ي'], ['ea', 'ي'], ['ie', 'ي'], ['ei', 'اي'], ['ai', 'اي'],
  ['ay', 'اي'], ['ey', 'اي'], ['oy', 'وي'], ['au', 'او'], ['aa', 'ا'], ['ae', 'ا'], ['oe', 'و'], ['ue', 'و'],
  ['ll', 'ل'], ['ss', 'س'], ['tt', 'ت'], ['pp', 'ب'], ['bb', 'ب'], ['dd', 'د'], ['ff', 'ف'], ['gg', 'غ'],
  ['mm', 'م'], ['nn', 'ن'], ['rr', 'ر'], ['zz', 'ز'], ['cc', 'ك'],
];
const ONE = {
  b: 'ب', c: 'ك', d: 'د', f: 'ف', g: 'غ', h: 'ه', j: 'ج', k: 'ك', l: 'ل', m: 'م', n: 'ن', p: 'ب', q: 'ق',
  r: 'ر', s: 'س', t: 'ت', v: 'ف', w: 'و', x: 'كس', z: 'ز', y: 'ي',
};

// Arabic names written in Latin letters: back to their own spelling (letters by sound can't tell ح from ه, ص from س).
const KNOWN = {
  franso: 'فرانسو', hariri: 'حريري', mohamed: 'محمد', mohammed: 'محمد', muhammad: 'محمد', mohammad: 'محمد', mohamad: 'محمد', ahmed: 'أحمد', ahmad: 'أحمد',
  ali: 'علي', salah: 'صلاح', abdullah: 'عبدالله', abdallah: 'عبدالله', hassan: 'حسن', hasan: 'حسن', hussein: 'حسين',
  hussain: 'حسين', husain: 'حسين', omar: 'عمر', umar: 'عمر', khalid: 'خالد', khaled: 'خالد', saud: 'سعود', salem: 'سالم',
  faisal: 'فيصل', yasser: 'ياسر', yaser: 'ياسر', saleh: 'صالح', salih: 'صالح', nasser: 'ناصر', naser: 'ناصر',
  hamdan: 'حمدان', zayed: 'زايد', zaid: 'زيد', bin: 'بن', ben: 'بن', abdul: 'عبد', mustafa: 'مصطفى', mostafa: 'مصطفى',
  youssef: 'يوسف', yousef: 'يوسف', youssouf: 'يوسف', yusuf: 'يوسف', ibrahim: 'إبراهيم', karim: 'كريم', sultan: 'سلطان',
  fahad: 'فهد', fahd: 'فهد', majed: 'ماجد', majid: 'ماجد', turki: 'تركي', bader: 'بدر', badr: 'بدر', nawaf: 'نواف',
  hattan: 'هتان', abdulrahman: 'عبدالرحمن', abdelrahman: 'عبدالرحمن', ayman: 'أيمن', aymen: 'أيمن', amjad: 'أمجد',
  alaa: 'علاء', hamad: 'حمد', jassim: 'جاسم', jasim: 'جاسم', rashid: 'راشد', rashed: 'راشد', mahmoud: 'محمود',
  salim: 'سليم', sami: 'سامي', riyad: 'رياض', riyadh: 'الرياض', mahrez: 'محرز', ziyech: 'زياش', hakimi: 'حكيمي',
  achraf: 'أشرف', ashraf: 'أشرف', amine: 'أمين', amin: 'أمين', yassine: 'ياسين', yasin: 'ياسين', bounou: 'بونو',
  firas: 'فراس', mohanad: 'مهند', muhanad: 'مهند', amir: 'أمير', ameer: 'أمير', saad: 'سعد', said: 'سعيد', saeed: 'سعيد',
  hamza: 'حمزة', hamzah: 'حمزة', yahya: 'يحيى', zakaria: 'زكريا', ismail: 'إسماعيل', ayoub: 'أيوب', bilal: 'بلال',
  tariq: 'طارق', tarek: 'طارق', walid: 'وليد', waleed: 'وليد', nabil: 'نبيل', jamal: 'جمال', kamal: 'كمال', adel: 'عادل',
  adil: 'عادل', abbas: 'عباس', haidar: 'حيدر', haider: 'حيدر', hayder: 'حيدر', mohannad: 'مهند', mazen: 'مازن',
  osama: 'أسامة', usama: 'أسامة', anas: 'أنس', aziz: 'عزيز', abdulaziz: 'عبدالعزيز', abdelaziz: 'عبدالعزيز',
  abdulelah: 'عبدالإله', saleem: 'سليم', nader: 'نادر', hani: 'هاني', ziad: 'زياد', ziyad: 'زياد', zidane: 'زيدان',
  benzema: 'بنزيما', kante: 'كانتي', mane: 'ماني', mbappe: 'مبابي', kane: 'كين', messi: 'ميسي', neymar: 'نيمار',
  ronaldo: 'رونالدو', cristiano: 'كريستيانو', vinicius: 'فينيسيوس', bellingham: 'بيلينغهام', yamal: 'يامال',
  lewandowski: 'ليفاندوفسكي', saka: 'ساكا', odegaard: 'أوديغارد', rice: 'رايس', palmer: 'بالمر', foden: 'فودن',
  rodri: 'رودري', pedri: 'بيدري', gavi: 'غافي', raphinha: 'رافينيا', kvaratskhelia: 'كفاراتسخيليا', osimhen: 'أوسيمين',
  lautaro: 'لاوتارو', martinez: 'مارتينيز', alvarez: 'ألفاريز', griezmann: 'غريزمان', dembele: 'ديمبيلي',
  hakim: 'حكيم', sofyan: 'سفيان', amrabat: 'أمرابط', diaz: 'دياز', nunez: 'نونيز', gakpo: 'غاكبو', son: 'سون',
  kalba: 'كلباء', ittihad: 'اتحاد', dhafra: 'الظفرة', wahda: 'الوحدة', jazira: 'الجزيرة', nasr: 'النصر',
  stadium: 'ملعب', city: 'سيتي', united: 'يونايتد', real: 'ريال', athletic: 'أتلتيك', sporting: 'سبورتينغ',
  sabah: 'صباح', dijk: 'دايك', baghdad: 'بغداد', basra: 'البصرة', basrah: 'البصرة', erbil: 'أربيل', karbala: 'كربلاء',
  najaf: 'النجف', jeddah: 'جدة', dammam: 'الدمام', doha: 'الدوحة', dubai: 'دبي', abu: 'أبو', dhabi: 'ظبي', sharjah: 'الشارقة',
  london: 'لندن', madrid: 'مدريد', paris: 'باريس', manchester: 'مانشستر', liverpool: 'ليفربول', milano: 'ميلانو',
  milan: 'ميلان', munich: 'ميونخ', munchen: 'ميونخ', barcelona: 'برشلونة', sevilla: 'إشبيلية', roma: 'روما', rome: 'روما',
  cairo: 'القاهرة', kuwait: 'الكويت', muscat: 'مسقط', amman: 'عمّان', sulaymaniyah: 'السليمانية', mosul: 'الموصل',
  road: 'رود', norwich: 'نوريتش', troyes: 'تروا', park: 'بارك', lane: 'لين', bridge: 'بريدج', king: 'الملك', prince: 'الأمير', international: 'الدولي',
};

/** One Latin word → Arabic letters. */
function word(w0) {
  const known = KNOWN[plain(w0).toLowerCase().replace(/[^a-z]/g, '')];
  if (known) return known;
  // French é at the end is said (Mbappé, Kanté).
  let w = plain(String(w0 || '').replace(/é$/i, 'i')).toLowerCase().replace(/[^a-z']/g, '');
  if (!w) return '';
  // «Kane», «Lane»: the e at the end makes the a an «ei».
  w = w.replace(/a([bcdfgklmnprstvz])e$/, 'ei$1').replace(/(e|a)y$/, 'i');
  // Spanish / Portuguese sounds.
  let s = w.replace(/oa/g, 'o').replace(/ñ/g, 'ny').replace(/ç/g, 's').replace(/lh/g, 'ly').replace(/nh/g, 'ny').replace(/'/g, '');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const first = i === 0, rest = s.slice(i);
    // Vowels.
    const v = rest[0];
    if ('aeiou'.includes(v)) {
      const g = GROUPS.find(([k]) => 'aeiou'.includes(k[0]) && rest.startsWith(k));
      const last = i + (g ? g[0].length : 1) >= s.length;
      if (first) {
        const k = g ? g[0] : v;
        out += ({ a: 'ا', e: 'إي', i: 'إي', o: 'أو', u: 'أو', ou: 'أو', oo: 'أو', au: 'أو', ee: 'إي', ea: 'إي', ei: 'اي',
          ie: 'إي', ai: 'اي', ay: 'اي', aa: 'آ', ae: 'ا', oe: 'أو', ue: 'أو', ey: 'اي', oy: 'أوي' })[k] || 'ا';
        i += k.length; continue;
      }
      if (g) { out += g[1]; i += g[0].length; continue; }
      // A lone vowel: a → ا, i → ي, o / u → و, e → ي (silent at the very end, as in «Kane», «Lille»).
      if (v === 'e') { if (!last) out += 'ي'; }
      else if (v === 'a') out += last && s.endsWith('ah') ? '' : 'ا';
      else out += v === 'i' ? 'ي' : 'و';
      i++; continue;
    }
    const g = GROUPS.find(([k]) => !'aeiou'.includes(k[0]) && rest.startsWith(k));
    if (g) { out += g[1]; i += g[0].length; continue; }
    // c / g are soft before e, i, y.
    const nx = s[i + 1] || '';
    if (v === 'c' && 'eiy'.includes(nx)) { out += 'س'; i++; continue; }
    if (v === 'h' && i === s.length - 1) { out += s.endsWith('ah') || s.endsWith('iyah') ? 'ة' : 'ه'; i++; continue; }
    if (v === 'y' && first && 'aeiou'.includes(nx)) { out += 'ي'; i++; continue; }
    out += ONE[v] || '';
    i++;
  }
  // «-iya / -iyah» endings.
  return out.replace(/ييا$/, 'ية').replace(/يية$/, 'ية').replace(/ياة$/, 'ية');
}

/** A whole name. «Al» / «El» before a word is the Arabic article (الهلال), joined to it. */
function words(s) {
  const parts = plain(s).replace(/[-–]/g, ' ').split(/\s+/).filter(Boolean);
  const out = [];
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k].toLowerCase();
    if ((p === 'al' || p === 'el') && parts[k + 1]) { const x = word(parts[++k]); out.push(x.startsWith('ال') ? x : 'ال' + x); continue; }
    if (/^(al|el)[-']?[a-z]/.test(p) && p.length > 4 && /^(al|el)-/.test(parts[k].toLowerCase())) { out.push('ال' + word(p.slice(3))); continue; }
    if (/^\d+$/.test(p)) { out.push(p); continue; }
    out.push(word(p));
  }
  return out.filter(Boolean).join(' ');
}

/** A team: FC / SC… dropped first. */
function team(en) {
  const clean = plain(en).replace(SUFFIX, ' ').replace(/\b(saudi)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  return words(clean || en);
}

/** A person: «T. Douvikas» → «دوفيكاس» (the name people know, his ask); [full] keeps every word but initials. */
function person(en, full = false) {
  const ps = plain(en).split(/\s+/).filter(p => p && !/^[A-Za-z]\.$/.test(p));
  if (!ps.length) return en || '';
  // The surname with the little words before it: «De Zerbi» → «دي زيربي», «van de Ven» → «فان دي فين».
  const PART = /^(van|von|de|da|di|del|della|der|den|dos|du|le|la|ten|ter|ben|bin|abu|el|al)$/i;
  let from = ps.length - 1;
  if (!full) while (from > 0 && PART.test(ps[from - 1])) from--;
  const pick = full ? ps : ps.slice(from);
  return pick.map(p => PARTICLE[p.toLowerCase()] || words(p)).join(' ');
}
const PARTICLE = { van: 'فان', von: 'فون', de: 'دي', da: 'دا', di: 'دي', del: 'ديل', della: 'ديلا', der: 'دير', den: 'دين',
  dos: 'دوس', du: 'دو', le: 'لو', la: 'لا', ten: 'تين', ter: 'تير', ben: 'بن', bin: 'بن', abu: 'أبو' };

const PLACE = [
  [/\b(stadium|stadion|stadio|estadio|estadi|stade|stadyumu|arena|ground)\b/gi, ''],
];
/** A stadium: «X Stadium» → «ملعب X». */
function venue(en) {
  if (!en) return '';
  let t = plain(en);
  const isStadium = PLACE.some(([r]) => { r.lastIndex = 0; return r.test(t); });
  for (const [r, v] of PLACE) t = t.replace(r, v);
  t = t.replace(/\b(de|del|la|el|do|da|of|the)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  const ar = words(t);
  return isStadium ? 'ملعب ' + ar : ar;
}

module.exports = { key, word, words, team, person, venue, plain };
