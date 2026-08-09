/* ==========================================================================
   TekYildizMC Sunucusu — v7
   - Veritabani ve OTURUMLAR artik MongoDB (Mongoose) uzerinde, KALICI.
     Eski surumde veritabani bir JSON dosyasiydi ve oturumlar bellekte
     (MemoryStore) tutuluyordu; sunucu uykuya girdiginde / yeniden
     baslatildiginda (orn. Render/Railway ucretsiz plan) hem dosya hem
     bellek sifirlanabiliyordu, bu da "1-2 saat sonra atiliyorum, tekrar
     giris yapamiyorum" sikayetinin sebebiydi. Artik hem kullanicilar hem
     oturumlar MongoDB'de sakli oldugu icin sunucu yeniden baslasa bile
     hicbir veri / oturum kaybolmaz.
   - Bagimliliklar: express, express-session, connect-mongo, mongoose,
     bcryptjs, dotenv (package.json guncellendi, "npm install" calistir).
   ========================================================================== */

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1); // Render/Railway gibi proxy arkasinda calisirken secure cookie + rate-limit icin sart, en basta olmali
const PORT = process.env.PORT || 3000;

// MongoDB baglanti adresi. Kendi ortaminda .env dosyasina
// MONGODB_URI=mongodb+srv://kullanici:sifre@cluster.mongodb.net/tekyildizmc
// seklinde MongoDB Atlas (ucretsiz) baglanti adresini yazmalisin.
// Yerelde MongoDB kuruluysa asagidaki varsayilan adres calisir.
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/tekyildizmc';

// Oturum (session) cookie'lerini imzalamak icin kullanilan gizli anahtar.
// PRODUCTION'DA MUTLAKA .env icinde SESSION_SECRET olarak kendi rastgele
// ve uzun anahtarini tanimla — asagidaki sadece yerel gelistirme icindir.
const SESSION_SECRET = process.env.SESSION_SECRET || 'tekyildizmc-cok-gizli-anahtar-BUNU-DEGISTIR';

const BASLANGIC_KREDISI = 100; // yeni kayit olan her kullaniciya otomatik tanimlanan kredi

// Magazadaki rutbelerin kredi fiyatlari (odeme.html ve admin panelinde de kullanilir)
const RUTBE_FIYATLARI = { 'VIP': 500, 'VIP+': 900, 'MVIP': 1500, 'MVIP+': 2200 };

// odeme.html'de secilebilecek TEK gecerli zaman araliklari (sadece hafta sonu).
// Sunucu tarafinda da dogrulanir; boylece istemci tarafi degistirilse bile
// gecersiz bir saat araligiyla siparis olusturulamaz.
const GECERLI_ZAMAN_ARALIKLARI = [
    '15:00 - 17:00 (Cumartesi / Pazar)',
    '17:45 - 20:00 (Cumartesi / Pazar)'
];

// Okunakli, karistirilmasi kolay olmayan (0,O,1,I,l gibi harfler olmadan)
// gecici sifreler uretir. Admin/moderator bunu oyuncuya Discord'dan iletir.
function geciciSifreUret() {
    const karakterler = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let sonuc = '';
    for (let i = 0; i < 10; i++) {
        sonuc += karakterler[crypto.randomInt(0, karakterler.length)];
    }
    return sonuc;
}

// "admin" kullanici adiyla kayit olan tek hesap otomatik yonetici olur.
function rolBelirle(kullaniciAdi) {
    return kullaniciAdi.toLowerCase() === 'admin' ? 'admin' : 'oyuncu';
}

// ==================== MONGOOSE SEMALARI / MODELLERI ====================
// Not: her semaya "toJSON: { virtuals: true }" verildi; boylece Mongo'nun
// ObjectId'si olan "_id" otomatik olarak string bir "id" alani olarak da
// gelir ve on-yuz (public/*.html) kodlari ".id" alanini kullanmaya devam eder.
const temizJSON = { virtuals: true, transform: (_doc, ret) => { delete ret._id; delete ret.__v; return ret; } };

const kullaniciSemasi = new mongoose.Schema({
    kullanici_adi: { type: String, required: true, unique: true, trim: true },
    sifre_hash: { type: String, required: true },
    rol: { type: String, enum: ['oyuncu', 'moderator', 'admin'], default: 'oyuncu' },
    rutbe: { type: String, default: 'Yok' },
    rutbe_bitis: { type: Date, default: null },
    durum: { type: String, enum: ['aktif', 'yasakli'], default: 'aktif' },
    kredi: { type: Number, default: BASLANGIC_KREDISI }, // MAGAZA KREDISI
    basarisiz_giris_sayisi: { type: Number, default: 0 },
    kilit_bitis: { type: Date, default: null },
    kayit_tarihi: { type: Date, default: Date.now }
}, { toJSON: temizJSON });
const Kullanici = mongoose.model('Kullanici', kullaniciSemasi);

const destekSemasi = new mongoose.Schema({
    kullanici_adi: { type: String, required: true },
    konu: { type: String, required: true },
    mesaj: { type: String, required: true },
    durum: { type: String, enum: ['bekliyor', 'cevaplandi', 'kapatildi'], default: 'bekliyor' },
    tarih: { type: Date, default: Date.now }
}, { toJSON: temizJSON });
const DestekTalebi = mongoose.model('DestekTalebi', destekSemasi);

const siparisSemasi = new mongoose.Schema({
    kullanici_adi: { type: String, required: true },
    oyun_ici_ad: { type: String, required: true },
    paket_adi: { type: String, required: true },
    fiyat: { type: Number, required: true }, // kredi cinsinden
    zaman_araligi: { type: String, required: true },
    durum: { type: String, enum: ['bekliyor', 'tamamlandi', 'iptal'], default: 'bekliyor' },
    kredi_iade_edildi: { type: Boolean, default: false },
    tarih: { type: Date, default: Date.now }
}, { toJSON: temizJSON });
const Siparis = mongoose.model('Siparis', siparisSemasi);

const duyuruSemasi = new mongoose.Schema({
    baslik: { type: String, required: true },
    icerik: { type: String, required: true },
    tarih: { type: Date, default: Date.now },
    yayin_tarihi: { type: Date, default: Date.now }
}, { toJSON: temizJSON });
const Duyuru = mongoose.model('Duyuru', duyuruSemasi);

const anketSemasi = new mongoose.Schema({
    soru: { type: String, required: true },
    secenekler: [{ id: Number, metin: String, oy: { type: Number, default: 0 } }],
    oylayanlar: { type: [String], default: [] },
    aktif: { type: Boolean, default: true },
    olusturma_tarihi: { type: Date, default: Date.now }
}, { toJSON: temizJSON });
const Anket = mongoose.model('Anket', anketSemasi);

const islemKaydiSemasi = new mongoose.Schema({
    yapan: { type: String, required: true },
    islem: { type: String, required: true },
    hedef: { type: String, default: '-' },
    detay: { type: String, default: '' },
    zaman: { type: Date, default: Date.now }
}, { toJSON: temizJSON });
const IslemKaydi = mongoose.model('IslemKaydi', islemKaydiSemasi);

// Admin/moderator islemlerini kaydeder ("kim ne zaman ne yapti").
// Son 500 kayitla sinirli tutulur, koleksiyon sonsuza kadar buyumesin diye.
async function islemKaydet(yapanAdi, islem, hedef, detay) {
    try {
        await IslemKaydi.create({ yapan: yapanAdi, islem, hedef: hedef || '-', detay: detay || '' });
        const toplam = await IslemKaydi.countDocuments();
        if (toplam > 500) {
            const silinecekler = await IslemKaydi.find().sort({ zaman: 1 }).limit(toplam - 500).select('_id');
            await IslemKaydi.deleteMany({ _id: { $in: silinecekler.map(k => k._id) } });
        }
    } catch (e) {
        console.error('Islem kaydedilirken hata:', e.message);
    }
}

// Rutbe suresi dolmus mu diye kontrol eder; doldu ise "Yok"a dusurur ve kaydeder.
async function rutbeSuresiniKontrolEt(user) {
    if (user.rutbe_bitis && user.rutbe && user.rutbe !== 'Yok' && new Date(user.rutbe_bitis) < new Date()) {
        user.rutbe = 'Yok';
        user.rutbe_bitis = null;
        await user.save();
    }
}

// ==================== MONGODB BAGLANTISI ====================

mongoose.set('strictQuery', true);

async function veritabaninaBaglan() {
    try {
        await mongoose.connect(MONGODB_URI);
        console.log('MongoDB baglantisi basarili: ' + mongoose.connection.name);

        // Ilk kurulumda "admin" adinda kimse yoksa, olusturulmasi gerektigini hatirlat.
        const adminVarMi = await Kullanici.exists({ rol: 'admin' });
        if (!adminVarMi) {
            console.log('Bilgi: Henuz "admin" rolunde bir hesap yok. /kayitol.html uzerinden');
            console.log('       kullanici adi "admin" olan bir hesap olusturursan otomatik yonetici olur.');
        }
    } catch (e) {
        console.error('MONGODB BAGLANTI HATASI:', e.message);
        console.error('MONGODB_URI ortam degiskenini kontrol et (.env dosyasi).');
        process.exit(1);
    }
}

mongoose.connection.on('disconnected', () => {
    console.warn('MongoDB baglantisi koptu, otomatik yeniden baglanmaya calisilacak...');
});
mongoose.connection.on('reconnected', () => {
    console.log('MongoDB baglantisi yeniden kuruldu.');
});

// ==================== ORTA KATMANLAR (MIDDLEWARE) ====================

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// OTURUMLAR ARTIK MONGODB'DE SAKLANIYOR (connect-mongo).
// Bu, kritik hatanin cozumudur: sunucu yeniden baslasa/uykuya girse bile
// aktif oturumlar MongoDB'deki "sessions" koleksiyonunda kalici kalir,
// kullanicilar tekrar giris yapmak zorunda kalmaz.
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
        mongoUrl: MONGODB_URI,
        collectionName: 'sessions',
        ttl: 14 * 24 * 60 * 60 // oturumlar 14 gun boyunca kalici kalir
    }),
    cookie: {
        maxAge: 1000 * 60 * 60 * 24 * 14, // 14 gun
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax'
    }
}));

// ---------- SAYFA KORUMASI ----------
function girisGerekli(req, res, next) {
    if (req.session && req.session.kullanici) return next();
    return res.redirect('/giris.html');
}
function yetkiliSayfaGerekli(req, res, next) {
    if (req.session && req.session.kullanici && (req.session.kullanici.rol === 'admin' || req.session.kullanici.rol === 'moderator')) return next();
    return res.redirect('/profil.html');
}

app.get('/profil.html', girisGerekli, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'profil.html'));
});
app.get('/admin.html', yetkiliSayfaGerekli, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/odeme.html', girisGerekli, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'odeme.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.redirect('/giris.html'));

// Basit saglik kontrolu — hosting servisinin (Render/UptimeRobot vb.)
// sunucuyu uyanik tutmak icin periyodik olarak ping atmasi icin kullanilabilir.
app.get('/api/saglik', (req, res) => {
    res.json({ durum: 'ayakta', mongo: mongoose.connection.readyState === 1 ? 'bagli' : 'bagli-degil' });
});

// ---------- GIRDI DOGRULAMA ----------
function girdiyiDogrula(kullanici_adi, sifre) {
    if (!kullanici_adi || !sifre) return 'Lutfen tum alanlari doldurun!';
    if (kullanici_adi.length < 3 || kullanici_adi.length > 16) return 'Kullanici adi 3-16 karakter olmali!';
    if (!/^[a-zA-Z0-9_]+$/.test(kullanici_adi)) return 'Kullanici adi sadece harf, rakam ve alt cizgi icerebilir!';
    if (sifre.length < 6) return 'Sifre en az 6 karakter olmali!';
    return null;
}

// ==================== KAYIT / GIRIS / OTURUM ====================

app.post('/api/kayitol', async (req, res) => {
    try {
        const { kullanici_adi, sifre } = req.body;
        const hata = girdiyiDogrula(kullanici_adi, sifre);
        if (hata) return res.json({ basarili: false, mesaj: hata });

        const temizAd = kullanici_adi.trim();

        const varMi = await Kullanici.findOne({ kullanici_adi: temizAd });
        if (varMi) return res.json({ basarili: false, mesaj: 'Bu kullanici adi zaten alinmis!' });

        const hash = await bcrypt.hash(sifre, 10);
        await Kullanici.create({
            kullanici_adi: temizAd,
            sifre_hash: hash,
            rol: rolBelirle(temizAd),
            kredi: BASLANGIC_KREDISI // yeni kayit olan kullaniciya otomatik baslangic kredisi
        });

        res.json({ basarili: true, mesaj: `Kayit basarili! Hesabina otomatik olarak ${BASLANGIC_KREDISI} kredi tanimlandi. Giris yapabilirsin.` });
    } catch (e) {
        if (e && e.code === 11000) {
            return res.json({ basarili: false, mesaj: 'Bu kullanici adi zaten alinmis!' });
        }
        console.error('KAYITOL HATASI:', e);
        res.status(500).json({ basarili: false, mesaj: 'Sunucu hatasi olustu, terminaldeki hatayi kontrol edin.' });
    }
});

app.post('/api/giris', async (req, res) => {
    try {
        const { kullanici_adi, sifre } = req.body;
        if (!kullanici_adi || !sifre) {
            return res.json({ basarili: false, mesaj: 'Lutfen tum alanlari doldurun!' });
        }

        const user = await Kullanici.findOne({ kullanici_adi: kullanici_adi.trim() });
        if (!user) return res.json({ basarili: false, mesaj: 'Kullanici bulunamadi veya sifre hatali!' });

        if (user.durum === 'yasakli') {
            return res.json({ basarili: false, mesaj: 'Hesabiniz yonetici tarafindan yasaklanmis.' });
        }

        // Hesap gecici kilitli mi? (5 basarisiz denemeden sonra 15 dakika)
        if (user.kilit_bitis && new Date(user.kilit_bitis) > new Date()) {
            const kalanDk = Math.ceil((new Date(user.kilit_bitis) - new Date()) / 60000);
            return res.json({ basarili: false, mesaj: `Cok fazla basarisiz deneme yapildi. Hesap ${kalanDk} dakika kilitli, sonra tekrar dene.` });
        }

        const dogruMu = await bcrypt.compare(sifre, user.sifre_hash);
        if (!dogruMu) {
            user.basarisiz_giris_sayisi = (user.basarisiz_giris_sayisi || 0) + 1;
            if (user.basarisiz_giris_sayisi >= 5) {
                user.kilit_bitis = new Date(Date.now() + 15 * 60 * 1000);
                user.basarisiz_giris_sayisi = 0;
                await user.save();
                return res.json({ basarili: false, mesaj: 'Cok fazla basarisiz deneme! Hesap 15 dakika kilitlendi.' });
            }
            await user.save();
            return res.json({ basarili: false, mesaj: 'Kullanici bulunamadi veya sifre hatali!' });
        }

        user.basarisiz_giris_sayisi = 0;
        user.kilit_bitis = null;
        await rutbeSuresiniKontrolEt(user);
        await user.save();

        req.session.kullanici = { id: user.id, kullanici_adi: user.kullanici_adi, rol: user.rol };
        // Oturumun MongoDB'ye hemen yazildigindan emin ol (sunucu bu istekten
        // hemen sonra yeniden baslasa/uykuya girse bile oturum kaybolmasin).
        req.session.save((err) => {
            if (err) console.error('OTURUM KAYDETME HATASI:', err);
            res.json({ basarili: true, mesaj: 'Giris basarili!' });
        });
    } catch (e) {
        console.error('GIRIS HATASI:', e);
        res.status(500).json({ basarili: false, mesaj: 'Sunucu hatasi olustu, terminaldeki hatayi kontrol edin.' });
    }
});

app.get('/api/me', (req, res) => {
    if (req.session && req.session.kullanici) {
        res.json({ girisYapildi: true, kullanici: req.session.kullanici });
    } else {
        res.json({ girisYapildi: false });
    }
});

app.get('/api/cikis', (req, res) => {
    req.session.destroy(() => {
        res.json({ basarili: true });
    });
});

app.get('/api/profilim', async (req, res) => {
    try {
        if (!req.session || !req.session.kullanici) {
            return res.status(401).json({ basarili: false, mesaj: 'Giris yapmalisiniz!' });
        }
        const user = await Kullanici.findOne({ kullanici_adi: req.session.kullanici.kullanici_adi });
        if (!user) return res.json({ basarili: false, mesaj: 'Bulunamadi.' });
        await rutbeSuresiniKontrolEt(user);
        const veri = user.toJSON();
        delete veri.sifre_hash;
        res.json({ basarili: true, veri });
    } catch (e) {
        console.error('PROFILIM HATASI:', e);
        res.status(500).json({ basarili: false, mesaj: 'Sunucu hatasi olustu.' });
    }
});

app.post('/api/hesapsil', async (req, res) => {
    try {
        if (!req.session || !req.session.kullanici) {
            return res.status(401).json({ basarili: false, mesaj: 'Giris yapmalisiniz!' });
        }
        const { sifre } = req.body;
        const kullaniciAdi = req.session.kullanici.kullanici_adi;
        if (!sifre) return res.json({ basarili: false, mesaj: 'Onaylamak icin sifreni gir!' });

        const user = await Kullanici.findOne({ kullanici_adi: kullaniciAdi });
        if (!user) return res.json({ basarili: false, mesaj: 'Hesap bulunamadi.' });

        const dogruMu = await bcrypt.compare(sifre, user.sifre_hash);
        if (!dogruMu) return res.json({ basarili: false, mesaj: 'Sifre yanlis!' });

        await Kullanici.deleteOne({ kullanici_adi: kullaniciAdi });

        req.session.destroy(() => {
            res.json({ basarili: true, mesaj: 'Hesabiniz basariyla silindi.' });
        });
    } catch (e) {
        console.error('HESAP SILME HATASI:', e);
        res.status(500).json({ basarili: false, mesaj: 'Sunucu hatasi olustu.' });
    }
});

// ==================== SIFRE / KULLANICI ADI DEGISTIRME (GIRIS YAPMIS KULLANICI) ====================

app.post('/api/sifredegistir', async (req, res) => {
    try {
        if (!req.session || !req.session.kullanici) {
            return res.status(401).json({ basarili: false, mesaj: 'Giris yapmalisiniz!' });
        }
        const { eskiSifre, yeniSifre } = req.body;
        if (!eskiSifre || !yeniSifre) return res.json({ basarili: false, mesaj: 'Lutfen tum alanlari doldurun!' });
        if (yeniSifre.length < 6) return res.json({ basarili: false, mesaj: 'Yeni sifre en az 6 karakter olmali!' });

        const user = await Kullanici.findOne({ kullanici_adi: req.session.kullanici.kullanici_adi });
        if (!user) return res.json({ basarili: false, mesaj: 'Hesap bulunamadi.' });

        const dogruMu = await bcrypt.compare(eskiSifre, user.sifre_hash);
        if (!dogruMu) return res.json({ basarili: false, mesaj: 'Mevcut sifren yanlis!' });

        user.sifre_hash = await bcrypt.hash(yeniSifre, 10);
        await user.save();

        res.json({ basarili: true, mesaj: 'Sifren basariyla degistirildi.' });
    } catch (e) {
        console.error('SIFRE DEGISTIRME HATASI:', e);
        res.status(500).json({ basarili: false, mesaj: 'Sunucu hatasi olustu.' });
    }
});

// Kullanici adi degisince destek/siparis gecmisindeki kayitlar da guncellenir,
// boylece gecmis kayitlar "yetim" kalmaz.
app.post('/api/kullaniciadidegistir', async (req, res) => {
    try {
        if (!req.session || !req.session.kullanici) {
            return res.status(401).json({ basarili: false, mesaj: 'Giris yapmalisiniz!' });
        }
        if (req.session.kullanici.rol === 'admin') {
            return res.json({ basarili: false, mesaj: 'Guvenlik nedeniyle admin hesabinin kullanici adi degistirilemez.' });
        }
        const { yeniKullaniciAdi, sifre } = req.body;
        if (!yeniKullaniciAdi || !sifre) return res.json({ basarili: false, mesaj: 'Lutfen tum alanlari doldurun!' });

        const temizYeni = yeniKullaniciAdi.trim();
        if (temizYeni.length < 3 || temizYeni.length > 16 || !/^[a-zA-Z0-9_]+$/.test(temizYeni)) {
            return res.json({ basarili: false, mesaj: 'Kullanici adi 3-16 karakter, sadece harf/rakam/alt cizgi olmali!' });
        }
        if (temizYeni.toLowerCase() === 'admin') {
            return res.json({ basarili: false, mesaj: 'Bu kullanici adi kullanilamaz.' });
        }

        const eskiAd = req.session.kullanici.kullanici_adi;
        if (temizYeni === eskiAd) return res.json({ basarili: false, mesaj: 'Bu zaten mevcut kullanici adin.' });

        const cakisan = await Kullanici.findOne({ kullanici_adi: new RegExp('^' + temizYeni + '$', 'i') });
        if (cakisan) return res.json({ basarili: false, mesaj: 'Bu kullanici adi zaten alinmis!' });

        const user = await Kullanici.findOne({ kullanici_adi: eskiAd });
        if (!user) return res.json({ basarili: false, mesaj: 'Hesap bulunamadi.' });

        const dogruMu = await bcrypt.compare(sifre, user.sifre_hash);
        if (!dogruMu) return res.json({ basarili: false, mesaj: 'Sifre yanlis!' });

        user.kullanici_adi = temizYeni;
        await user.save();
        await DestekTalebi.updateMany({ kullanici_adi: eskiAd }, { $set: { kullanici_adi: temizYeni } });
        await Siparis.updateMany({ kullanici_adi: eskiAd }, { $set: { kullanici_adi: temizYeni } });

        req.session.kullanici.kullanici_adi = temizYeni;
        res.json({ basarili: true, mesaj: 'Kullanici adin guncellendi.', yeniKullaniciAdi: temizYeni });
    } catch (e) {
        console.error('KULLANICI ADI DEGISTIRME HATASI:', e);
        res.status(500).json({ basarili: false, mesaj: 'Sunucu hatasi olustu.' });
    }
});

// ==================== DESTEK TALEPLERI ====================

app.post('/api/destek', async (req, res) => {
    try {
        const { konu, mesaj } = req.body;
        if (!konu || !mesaj) return res.json({ basarili: false, mesaj: 'Lutfen tum alanlari doldurun!' });

        const kullaniciAdi = (req.session && req.session.kullanici)
            ? req.session.kullanici.kullanici_adi
            : (req.body.oyuncu_adi ? ('Misafir: ' + req.body.oyuncu_adi.trim()) : 'Misafir: Bilinmiyor');

        await DestekTalebi.create({ kullanici_adi: kullaniciAdi, konu: konu.trim(), mesaj: mesaj.trim() });

        res.json({ basarili: true, mesaj: 'Destek talebin yetkililere iletildi!' });
    } catch (e) {
        console.error('DESTEK HATASI:', e);
        res.status(500).json({ basarili: false, mesaj: 'Sunucu hatasi olustu.' });
    }
});

app.get('/api/destek/benim', async (req, res) => {
    if (!req.session || !req.session.kullanici) return res.status(401).json({ basarili: false });
    const kayitlar = await DestekTalebi.find({ kullanici_adi: req.session.kullanici.kullanici_adi }).sort({ tarih: -1 });
    res.json({ basarili: true, veri: kayitlar });
});

// ==================== SIPARISLER / MAGAZA / KREDI SISTEMI ====================

// Magazadaki rutbe fiyatlarini herkese acik sekilde dondurur (magaza.html bunu kullanir,
// boylece fiyatlar tek bir yerden -RUTBE_FIYATLARI- yonetilir).
app.get('/api/magaza/fiyatlar', (req, res) => {
    res.json({ basarili: true, veri: RUTBE_FIYATLARI, gecerli_saatler: GECERLI_ZAMAN_ARALIKLARI });
});

// Siparis (rutbe satin alma talebi) olusturur.
// - Sadece giris yapmis kullanicilar siparis verebilir.
// - Fiyat SUNUCU tarafindaki RUTBE_FIYATLARI tablosundan alinir (istemciden gelen
//   fiyat asla dogrudan guvenilmez, boylece tarayici konsolundan fiyat degistirilemez).
// - Bakiye yetersizse siparis OLUSTURULMAZ ve acik bir hata donulur.
// - Bakiye yeterliyse kredi HEMEN dusulur (rezerve edilir) ve siparis "bekliyor"
//   durumuyla kaydedilir. Rutbe, admin onaylayana kadar KESINLIKLE hesaba islenmez.
// - Admin siparisi iptal ederse dusulen kredi otomatik iade edilir.
app.post('/api/siparis', async (req, res) => {
    try {
        if (!req.session || !req.session.kullanici) {
            return res.status(401).json({ basarili: false, mesaj: 'Siparis vermek icin giris yapmalisiniz!' });
        }
        const { paket_adi, oyun_ici_ad, zaman_araligi } = req.body;

        if (!paket_adi || !RUTBE_FIYATLARI.hasOwnProperty(paket_adi)) {
            return res.json({ basarili: false, mesaj: 'Gecersiz paket secildi.' });
        }
        if (!oyun_ici_ad || !oyun_ici_ad.trim()) {
            return res.json({ basarili: false, mesaj: 'Oyun ici adini girmelisin!' });
        }
        if (!zaman_araligi || !GECERLI_ZAMAN_ARALIKLARI.includes(zaman_araligi)) {
            return res.json({ basarili: false, mesaj: 'Lutfen listeden gecerli bir zaman araligi sec (rutbeler sadece Cumartesi/Pazar belirtilen saatlerde teslim edilir).' });
        }

        const fiyat = RUTBE_FIYATLARI[paket_adi];

        const user = await Kullanici.findOne({ kullanici_adi: req.session.kullanici.kullanici_adi });
        if (!user) return res.json({ basarili: false, mesaj: 'Hesap bulunamadi.' });

        if ((user.kredi || 0) < fiyat) {
            return res.json({ basarili: false, mesaj: 'Yetersiz bakiye!', kredi: user.kredi, gereken: fiyat });
        }

        user.kredi -= fiyat;
        await user.save();

        const yeniSiparis = await Siparis.create({
            kullanici_adi: user.kullanici_adi,
            oyun_ici_ad: oyun_ici_ad.trim(),
            paket_adi,
            fiyat,
            zaman_araligi,
            durum: 'bekliyor'
        });

        res.json({
            basarili: true,
            mesaj: 'Yetkililerinize almak istediginiz rutbe iletildi. Online oldugunuz saatler icinde rutbeniz verilecektir.',
            siparis_id: yeniSiparis.id,
            kalanKredi: user.kredi
        });
    } catch (e) {
        console.error('SIPARIS HATASI:', e);
        res.status(500).json({ basarili: false, mesaj: 'Sunucu hatasi olustu.' });
    }
});

app.get('/api/siparis/benim', async (req, res) => {
    if (!req.session || !req.session.kullanici) return res.status(401).json({ basarili: false });
    const kayitlar = await Siparis.find({ kullanici_adi: req.session.kullanici.kullanici_adi }).sort({ tarih: -1 });
    res.json({ basarili: true, veri: kayitlar });
});

// ==================== HERKESE ACIK KUCUK UCLAR (anasayfa widget'lari) ====================

// Son kayit olan oyuncular (GERCEK oyun-ici giris DEGIL, siteye kayit tarihine gore -
// gercek oyun-ici "son katilanlar" icin bir Minecraft eklentisi/API entegrasyonu gerekir)
app.get('/api/son-kayitlar', async (req, res) => {
    const sonlar = await Kullanici.find({ rol: { $ne: 'admin' }, durum: { $ne: 'yasakli' } })
        .sort({ kayit_tarihi: -1 })
        .limit(5)
        .select('kullanici_adi kayit_tarihi');
    res.json({ basarili: true, veri: sonlar.map(u => ({ kullanici_adi: u.kullanici_adi, kayit_tarihi: u.kayit_tarihi })) });
});

// ==================== ANKET / OYLAMA ====================

app.get('/api/anket/aktif', async (req, res) => {
    const anket = await Anket.findOne({ aktif: true });
    if (!anket) return res.json({ basarili: true, anket: null });

    const kullaniciAdi = (req.session && req.session.kullanici) ? req.session.kullanici.kullanici_adi : null;
    const oyVerdiMi = kullaniciAdi ? anket.oylayanlar.includes(kullaniciAdi) : false;
    res.json({ basarili: true, anket, oyVerdiMi });
});

app.post('/api/anket/oyla', async (req, res) => {
    try {
        if (!req.session || !req.session.kullanici) {
            return res.status(401).json({ basarili: false, mesaj: 'Oy vermek icin giris yapmalisin!' });
        }
        const { anket_id, secenek_id } = req.body;
        if (!anket_id || !mongoose.isValidObjectId(anket_id)) {
            return res.json({ basarili: false, mesaj: 'Gecersiz anket.' });
        }
        const anket = await Anket.findOne({ _id: anket_id, aktif: true });
        if (!anket) return res.json({ basarili: false, mesaj: 'Bu anket artik aktif degil.' });

        const kullaniciAdi = req.session.kullanici.kullanici_adi;
        if (anket.oylayanlar.includes(kullaniciAdi)) {
            return res.json({ basarili: false, mesaj: 'Bu ankete zaten oy verdin!' });
        }
        const secenek = anket.secenekler.find(s => s.id === Number(secenek_id));
        if (!secenek) return res.json({ basarili: false, mesaj: 'Gecersiz secenek.' });

        secenek.oy += 1;
        anket.oylayanlar.push(kullaniciAdi);
        await anket.save();
        res.json({ basarili: true, mesaj: 'Oyun kaydedildi, tesekkurler!', anket });
    } catch (e) {
        console.error('ANKET OYLAMA HATASI:', e);
        res.status(500).json({ basarili: false, mesaj: 'Sunucu hatasi olustu.' });
    }
});

// ==================== ADMIN / MODERATOR API'LERI ====================

// Sadece admin (kredi/yetki iceren hassas islemler)
function adminApiKorumasi(req, res, next) {
    if (req.session && req.session.kullanici && req.session.kullanici.rol === 'admin') return next();
    return res.status(403).json({ basarili: false, mesaj: 'Bu islem icin yonetici yetkisi gerekli!' });
}
// Admin VEYA moderator (destek/moderasyon agirlikli islemler)
function personelApiKorumasi(req, res, next) {
    if (req.session && req.session.kullanici && (req.session.kullanici.rol === 'admin' || req.session.kullanici.rol === 'moderator')) return next();
    return res.status(403).json({ basarili: false, mesaj: 'Bu islem icin yetki gerekli!' });
}
// Bir moderatorun admin veya baska bir moderatore islem yapmasini engeller
async function korunanHedefMi(kullanici_adi) {
    const hedef = await Kullanici.findOne({ kullanici_adi });
    return !!(hedef && (hedef.rol === 'admin' || hedef.rol === 'moderator'));
}

// Kullanici listesi. Admin ayrica her kullanicinin sifre hash'inin KISALTILMIS
// bir onizlemesini de gorur (ilk 20 karakter + "..."). Sifreler asla duz metin
// olarak saklanmadigindan (bcrypt tek yonlu hash'tir) gercek sifre gosterilemez;
// admin bir kullanicinin sifresini gormek/degistirmek isterse asagidaki
// "/api/admin/sifre-belirle" (ozel yeni sifre) veya "/api/admin/sifre-sifirla"
// (rastgele gecici sifre) uclarini kullanir.
app.get('/api/admin/kullanicilar', personelApiKorumasi, async (req, res) => {
    try {
        const kullanicilar = await Kullanici.find().sort({ kayit_tarihi: -1 });
        const guvenli = kullanicilar.map(u => {
            const veri = u.toJSON();
            if (req.session.kullanici.rol === 'admin') {
                veri.sifre_hash_onizleme = veri.sifre_hash.slice(0, 20) + '...';
            }
            delete veri.sifre_hash;
            return veri;
        });
        res.json({ basarili: true, veri: guvenli });
    } catch (e) {
        console.error('KULLANICI LISTESI HATASI:', e);
        res.status(500).json({ basarili: false, mesaj: 'Sunucu hatasi olustu.' });
    }
});

// Rutbe verme KREDI/PARA ile ilgili oldugu icin sadece admin yapabilir.
app.post('/api/admin/rutbe-ver', adminApiKorumasi, async (req, res) => {
    try {
        const { kullanici_adi, rutbe, sure } = req.body; // sure: '7' | '30' | '90' | 'suresiz'
        if (!kullanici_adi || !rutbe) return res.json({ basarili: false, mesaj: 'Eksik bilgi.' });
        if (kullanici_adi.toLowerCase() === 'admin') {
            return res.json({ basarili: false, mesaj: 'Admin hesabinin rutbesi degistirilemez.' });
        }
        const user = await Kullanici.findOne({ kullanici_adi });
        if (!user) return res.json({ basarili: false, mesaj: 'Kullanici bulunamadi.' });

        user.rutbe = rutbe;
        if (rutbe === 'Yok') {
            user.rutbe_bitis = null;
        } else if (sure && sure !== 'suresiz') {
            const gun = parseInt(sure, 10);
            user.rutbe_bitis = !isNaN(gun) ? new Date(Date.now() + gun * 24 * 60 * 60 * 1000) : null;
        } else {
            user.rutbe_bitis = null; // suresiz
        }
        await user.save();

        await islemKaydet(req.session.kullanici.kullanici_adi, 'Rütbe Verdi', kullanici_adi, `${rutbe}${user.rutbe_bitis ? ' - biter: ' + user.rutbe_bitis.toISOString().slice(0, 10) : ' - süresiz'}`);
        res.json({ basarili: true, mesaj: `${kullanici_adi} adli oyuncuya ${rutbe} rutbesi verildi.` });
    } catch (e) {
        console.error('RUTBE VERME HATASI:', e);
        res.status(500).json({ basarili: false, mesaj: 'Sunucu hatasi olustu.' });
    }
});

// Ban/aktif etme moderator de yapabilir, ama admin veya baska moderatore dokunamaz.
app.post('/api/admin/hesap-durum', personelApiKorumasi, async (req, res) => {
    try {
        const { kullanici_adi, durum } = req.body;
        if (!kullanici_adi || !durum) return res.json({ basarili: false, mesaj: 'Eksik bilgi.' });
        if (kullanici_adi.toLowerCase() === 'admin') {
            return res.json({ basarili: false, mesaj: 'Admin hesabi yasaklanamaz.' });
        }
        if (req.session.kullanici.rol === 'moderator' && await korunanHedefMi(kullanici_adi)) {
            return res.json({ basarili: false, mesaj: 'Bu hesaba islem yapma yetkin yok.' });
        }
        const user = await Kullanici.findOne({ kullanici_adi });
        if (!user) return res.json({ basarili: false, mesaj: 'Kullanici bulunamadi.' });
        user.durum = durum;
        await user.save();
        await islemKaydet(req.session.kullanici.kullanici_adi, durum === 'yasakli' ? 'Hesap Yasakladı' : 'Hesabı Aktif Etti', kullanici_adi);
        res.json({ basarili: true, mesaj: `${kullanici_adi} adli hesabin durumu "${durum}" olarak guncellendi.` });
    } catch (e) {
        console.error('HESAP DURUM HATASI:', e);
        res.status(500).json({ basarili: false, mesaj: 'Sunucu hatasi olustu.' });
    }
});

// Hesap SILME geri alinamaz oldugu icin sadece admin yapabilir.
app.post('/api/admin/hesap-sil', adminApiKorumasi, async (req, res) => {
    try {
        const { kullanici_adi } = req.body;
        if (!kullanici_adi) return res.json({ basarili: false, mesaj: 'Eksik bilgi.' });
        if (kullanici_adi.toLowerCase() === 'admin') {
            return res.json({ basarili: false, mesaj: 'Admin hesabi silinemez.' });
        }
        const sonuc = await Kullanici.deleteOne({ kullanici_adi });
        if (sonuc.deletedCount === 0) {
            return res.json({ basarili: false, mesaj: 'Kullanici bulunamadi.' });
        }
        await islemKaydet(req.session.kullanici.kullanici_adi, 'Hesap Sildi', kullanici_adi);
        res.json({ basarili: true, mesaj: `${kullanici_adi} adli hesap silindi.` });
    } catch (e) {
        console.error('HESAP SILME (ADMIN) HATASI:', e);
        res.status(500).json({ basarili: false, mesaj: 'Sunucu hatasi olustu.' });
    }
});

// Oyuncu sifresini unuttugunda Discord/destek uzerinden ulasir; admin/moderator bu
// buton ile o oyuncu icin gecici (rastgele) bir sifre uretir.
app.post('/api/admin/sifre-sifirla', personelApiKorumasi, async (req, res) => {
    try {
        const { kullanici_adi } = req.body;
        if (!kullanici_adi) return res.json({ basarili: false, mesaj: 'Eksik bilgi.' });

        if (req.session.kullanici.rol === 'moderator' && await korunanHedefMi(kullanici_adi)) {
            return res.json({ basarili: false, mesaj: 'Bu hesaba islem yapma yetkin yok.' });
        }
        const user = await Kullanici.findOne({ kullanici_adi });
        if (!user) return res.json({ basarili: false, mesaj: 'Kullanici bulunamadi.' });

        const geciciSifre = geciciSifreUret();
        user.sifre_hash = await bcrypt.hash(geciciSifre, 10);
        await user.save();
        await islemKaydet(req.session.kullanici.kullanici_adi, 'Şifre Sıfırladı', kullanici_adi);

        res.json({
            basarili: true,
            mesaj: `${kullanici_adi} icin yeni gecici sifre olusturuldu. Bunu oyuncuya Discord'dan ilet, giris yaptiktan sonra profilinden kendi sifresini belirlemesini soyle.`,
            gecici_sifre: geciciSifre
        });
    } catch (e) {
        console.error('SIFRE SIFIRLAMA HATASI:', e);
        res.status(500).json({ basarili: false, mesaj: 'Sunucu hatasi olustu.' });
    }
});

// Admin, bir kullanici icin KENDI SECTIGI ozel bir yeni sifre belirleyebilir
// (rastgele uretilen gecici sifre yerine). Sifreler veritabaninda sadece
// bcrypt hash'i olarak saklanir, admin panelinde asla duz metin gosterilmez.
app.post('/api/admin/sifre-belirle', adminApiKorumasi, async (req, res) => {
    try {
        const { kullanici_adi, yeniSifre } = req.body;
        if (!kullanici_adi || !yeniSifre) return res.json({ basarili: false, mesaj: 'Eksik bilgi.' });
        if (yeniSifre.length < 6) return res.json({ basarili: false, mesaj: 'Yeni sifre en az 6 karakter olmali!' });

        const user = await Kullanici.findOne({ kullanici_adi });
        if (!user) return res.json({ basarili: false, mesaj: 'Kullanici bulunamadi.' });

        user.sifre_hash = await bcrypt.hash(yeniSifre, 10);
        await user.save();
        await islemKaydet(req.session.kullanici.kullanici_adi, 'Şifre Belirledi (elle)', kullanici_adi);

        res.json({ basarili: true, mesaj: `${kullanici_adi} adli hesabin sifresi guncellendi.` });
    } catch (e) {
        console.error('SIFRE BELIRLEME HATASI:', e);
        res.status(500).json({ basarili: false, mesaj: 'Sunucu hatasi olustu.' });
    }
});

// Moderatorluk atama/kaldirma sadece admin'de.
app.post('/api/admin/rol-ver', adminApiKorumasi, async (req, res) => {
    try {
        const { kullanici_adi, rol } = req.body; // 'oyuncu' | 'moderator'
        if (!kullanici_adi || !['oyuncu', 'moderator'].includes(rol)) {
            return res.json({ basarili: false, mesaj: 'Gecersiz istek.' });
        }
        if (kullanici_adi.toLowerCase() === 'admin') {
            return res.json({ basarili: false, mesaj: 'Admin rolu degistirilemez.' });
        }
        const user = await Kullanici.findOne({ kullanici_adi });
        if (!user) return res.json({ basarili: false, mesaj: 'Kullanici bulunamadi.' });
        user.rol = rol;
        await user.save();
        await islemKaydet(req.session.kullanici.kullanici_adi, rol === 'moderator' ? 'Moderatör Yaptı' : 'Moderatörlüğü Aldı', kullanici_adi);
        res.json({ basarili: true, mesaj: `${kullanici_adi} artik ${rol === 'moderator' ? 'moderator' : 'normal oyuncu'}.` });
    } catch (e) {
        console.error('ROL VERME HATASI:', e);
        res.status(500).json({ basarili: false, mesaj: 'Sunucu hatasi olustu.' });
    }
});

// Admin bir oyuncuya elle kredi ekleyip cikarabilir (etkinlik odulu, iade, ceza vb.)
// KREDI ile ilgili oldugu icin sadece admin yapabilir.
app.post('/api/admin/kredi-guncelle', adminApiKorumasi, async (req, res) => {
    try {
        const { kullanici_adi, kredi_ekle } = req.body;
        if (!kullanici_adi || kredi_ekle === undefined) return res.json({ basarili: false, mesaj: 'Eksik bilgi.' });
        if (kullanici_adi.toLowerCase() === 'admin') {
            return res.json({ basarili: false, mesaj: 'Admin hesabinin kredisi degistirilemez.' });
        }
        const delta = parseInt(kredi_ekle, 10);
        if (isNaN(delta)) return res.json({ basarili: false, mesaj: 'Gecerli bir sayi gir.' });

        const user = await Kullanici.findOne({ kullanici_adi });
        if (!user) return res.json({ basarili: false, mesaj: 'Kullanici bulunamadi.' });

        user.kredi = Math.max(0, (typeof user.kredi === 'number' ? user.kredi : 0) + delta);
        await user.save();
        await islemKaydet(req.session.kullanici.kullanici_adi, 'Kredi Güncelledi', kullanici_adi, (delta >= 0 ? '+' : '') + delta);
        res.json({ basarili: true, mesaj: `${kullanici_adi} adli oyuncunun kredisi guncellendi.`, yeniKredi: user.kredi });
    } catch (e) {
        console.error('KREDI GUNCELLEME HATASI:', e);
        res.status(500).json({ basarili: false, mesaj: 'Sunucu hatasi olustu.' });
    }
});

// ---------- ISLEM KAYITLARI (audit log) ----------
app.get('/api/admin/islem-kayitlari', personelApiKorumasi, async (req, res) => {
    const kayitlar = await IslemKaydi.find().sort({ zaman: -1 }).limit(500);
    res.json({ basarili: true, veri: kayitlar });
});

app.get('/api/admin/destek-talepleri', personelApiKorumasi, async (req, res) => {
    const kayitlar = await DestekTalebi.find().sort({ tarih: -1 });
    res.json({ basarili: true, veri: kayitlar });
});

app.post('/api/admin/destek-guncelle', personelApiKorumasi, async (req, res) => {
    try {
        const { id, durum } = req.body;
        if (!id || !durum) return res.json({ basarili: false, mesaj: 'Eksik bilgi.' });
        const talep = await DestekTalebi.findById(id);
        if (!talep) return res.json({ basarili: false, mesaj: 'Talep bulunamadi.' });
        talep.durum = durum;
        await talep.save();
        res.json({ basarili: true, mesaj: 'Talep guncellendi.' });
    } catch (e) {
        res.json({ basarili: false, mesaj: 'Gecersiz talep.' });
    }
});

// Siparisleri listeler — hem "bekleyen siparisler" hem "rutbe alan oyuncular"
// (durum: tamamlandi) admin panelinden burada net sekilde gorulur.
app.get('/api/admin/siparisler', personelApiKorumasi, async (req, res) => {
    const siparisler = await Siparis.find().sort({ tarih: -1 });
    res.json({ basarili: true, veri: siparisler });
});

// Siparis onaylama/reddetme KREDI ile ilgili oldugu icin sadece admin yapabilir.
// - "tamamlandi": rutbe_ver true ise kullaniciya rutbe taninir (kredi zaten
//   siparis olusturulurken dusulmustu, tekrar dusulmez).
// - "iptal": eger kredi daha once iade edilmediyse, dusulen kredi kullaniciya
//   geri iade edilir (kredi_iade_edildi ile ayni siparisin iki kez iade
//   edilmesi engellenir).
app.post('/api/admin/siparis-guncelle', adminApiKorumasi, async (req, res) => {
    try {
        const { id, durum, rutbe_ver } = req.body;
        if (!id || !durum) return res.json({ basarili: false, mesaj: 'Eksik bilgi.' });

        const siparis = await Siparis.findById(id);
        if (!siparis) return res.json({ basarili: false, mesaj: 'Siparis bulunamadi.' });

        siparis.durum = durum;

        if (durum === 'tamamlandi') {
            const user = await Kullanici.findOne({ kullanici_adi: siparis.kullanici_adi });
            if (user && rutbe_ver) {
                user.rutbe = siparis.paket_adi;
                await user.save();
            }
            await islemKaydet(req.session.kullanici.kullanici_adi, 'Siparişi Onayladı', siparis.kullanici_adi, `${siparis.paket_adi} (${siparis.fiyat} kredi)`);
        } else if (durum === 'iptal' && !siparis.kredi_iade_edildi) {
            const user = await Kullanici.findOne({ kullanici_adi: siparis.kullanici_adi });
            if (user) {
                user.kredi = (typeof user.kredi === 'number' ? user.kredi : 0) + siparis.fiyat;
                await user.save();
            }
            siparis.kredi_iade_edildi = true;
            await islemKaydet(req.session.kullanici.kullanici_adi, 'Siparişi İptal Etti (kredi iade)', siparis.kullanici_adi, `${siparis.paket_adi} (${siparis.fiyat} kredi iade)`);
        }

        await siparis.save();
        res.json({ basarili: true, mesaj: 'Siparis guncellendi.' });
    } catch (e) {
        console.error('SIPARIS GUNCELLEME HATASI:', e);
        res.status(500).json({ basarili: false, mesaj: 'Gecersiz siparis veya sunucu hatasi.' });
    }
});

// ==================== DUYURULAR (ileri tarihli yayin destekli) ====================

app.get('/api/duyurular', async (req, res) => {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 5;
    const simdi = new Date();
    const sirali = await Duyuru.find({ yayin_tarihi: { $lte: simdi } }).sort({ tarih: -1 }).limit(limit);
    res.json({ basarili: true, veri: sirali });
});

app.get('/api/admin/duyurular', personelApiKorumasi, async (req, res) => {
    const sirali = await Duyuru.find().sort({ tarih: -1 });
    res.json({ basarili: true, veri: sirali });
});

app.post('/api/admin/duyuru-ekle', personelApiKorumasi, async (req, res) => {
    try {
        const { baslik, icerik, yayin_tarihi } = req.body;
        if (!baslik || !icerik) return res.json({ basarili: false, mesaj: 'Baslik ve icerik gerekli.' });

        const yeniDuyuru = await Duyuru.create({
            baslik: baslik.trim(),
            icerik: icerik.trim(),
            yayin_tarihi: yayin_tarihi ? new Date(yayin_tarihi) : new Date()
        });
        await islemKaydet(req.session.kullanici.kullanici_adi, 'Duyuru Ekledi', baslik.trim());
        const ileriTarihli = new Date(yeniDuyuru.yayin_tarihi) > new Date();
        res.json({ basarili: true, mesaj: ileriTarihli ? `Duyuru ${new Date(yeniDuyuru.yayin_tarihi).toLocaleString('tr-TR')} tarihinde yayinlanacak.` : 'Duyuru yayinlandi.' });
    } catch (e) {
        console.error('DUYURU EKLEME HATASI:', e);
        res.status(500).json({ basarili: false, mesaj: 'Sunucu hatasi olustu.' });
    }
});

app.post('/api/admin/duyuru-sil', personelApiKorumasi, async (req, res) => {
    try {
        const { id } = req.body;
        if (!id) return res.json({ basarili: false, mesaj: 'Eksik bilgi.' });
        const sonuc = await Duyuru.deleteOne({ _id: id });
        if (sonuc.deletedCount === 0) return res.json({ basarili: false, mesaj: 'Duyuru bulunamadi.' });
        res.json({ basarili: true, mesaj: 'Duyuru silindi.' });
    } catch (e) {
        res.json({ basarili: false, mesaj: 'Gecersiz duyuru.' });
    }
});

// ==================== ADMIN: ANKET YONETIMI ====================

app.get('/api/admin/anketler', personelApiKorumasi, async (req, res) => {
    const sirali = await Anket.find().sort({ olusturma_tarihi: -1 });
    res.json({ basarili: true, veri: sirali });
});

app.post('/api/admin/anket-olustur', personelApiKorumasi, async (req, res) => {
    try {
        const { soru, secenekler } = req.body; // secenekler: string[]
        if (!soru || !Array.isArray(secenekler) || secenekler.filter(s => s && s.trim()).length < 2) {
            return res.json({ basarili: false, mesaj: 'Bir soru ve en az 2 secenek gir.' });
        }
        await Anket.updateMany({ aktif: true }, { $set: { aktif: false } }); // ayni anda tek aktif anket olsun
        await Anket.create({
            soru: soru.trim(),
            secenekler: secenekler.filter(s => s && s.trim()).map((metin, i) => ({ id: i + 1, metin: metin.trim(), oy: 0 })),
            oylayanlar: [],
            aktif: true
        });
        await islemKaydet(req.session.kullanici.kullanici_adi, 'Anket Oluşturdu', soru.trim());
        res.json({ basarili: true, mesaj: 'Anket yayinlandi.' });
    } catch (e) {
        console.error('ANKET OLUSTURMA HATASI:', e);
        res.status(500).json({ basarili: false, mesaj: 'Sunucu hatasi olustu.' });
    }
});

app.post('/api/admin/anket-kapat', personelApiKorumasi, async (req, res) => {
    try {
        const { id } = req.body;
        const anket = await Anket.findById(id);
        if (!anket) return res.json({ basarili: false, mesaj: 'Anket bulunamadi.' });
        anket.aktif = false;
        await anket.save();
        res.json({ basarili: true, mesaj: 'Anket kapatildi.' });
    } catch (e) {
        res.json({ basarili: false, mesaj: 'Gecersiz anket.' });
    }
});

app.post('/api/admin/anket-sil', personelApiKorumasi, async (req, res) => {
    try {
        const { id } = req.body;
        const sonuc = await Anket.deleteOne({ _id: id });
        if (sonuc.deletedCount === 0) return res.json({ basarili: false, mesaj: 'Anket bulunamadi.' });
        res.json({ basarili: true, mesaj: 'Anket silindi.' });
    } catch (e) {
        res.json({ basarili: false, mesaj: 'Gecersiz anket.' });
    }
});

// ==================== SIRALAMA TABLOSU ====================

app.get('/api/siralama', async (req, res) => {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 10;
    const kullanicilar = await Kullanici.find({ rol: { $ne: 'admin' }, durum: { $ne: 'yasakli' } })
        .sort({ kredi: -1 })
        .limit(limit)
        .select('kullanici_adi rutbe kredi');
    const siralama = kullanicilar.map(u => ({ kullanici_adi: u.kullanici_adi, rutbe: u.rutbe, puan: (typeof u.kredi === 'number' ? u.kredi : 0) }));
    res.json({ basarili: true, veri: siralama });
});

// ==================== 404 (bilinmeyen API uclari) ====================
app.use('/api', (req, res) => {
    res.status(404).json({ basarili: false, mesaj: 'Bilinmeyen istek.' });
});

// ==================== SUNUCUYU BASLAT ====================

async function baslat() {
    await veritabaninaBaglan();

    const sunucu = app.listen(PORT, () => {
        console.log('==========================================');
        console.log(' TekYildizMC Sunucusu Hazir!');
        console.log(' Tarayicidan sunu ac: http://localhost:' + PORT + '/giris.html');
        console.log('==========================================');
    });

    sunucu.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error('');
            console.error('HATA: ' + PORT + ' portu zaten kullanimda!');
            console.error('Muhtemelen baska bir "node server.js" penceresi hala acik.');
            console.error('O eski siyah pencereyi kapatip tekrar dene.');
            console.error('');
        } else {
            console.error('Sunucu baslatma hatasi:', err);
        }
        process.exit(1);
    });
}

baslat();

process.on('uncaughtException', (err) => {
    console.error('BEKLENMEYEN HATA (sunucu kapanmadi, ama bu hatayi bildir):', err);
});
process.on('unhandledRejection', (err) => {
    console.error('BEKLENMEYEN PROMISE HATASI (sunucu kapanmadi, ama bu hatayi bildir):', err);
});
