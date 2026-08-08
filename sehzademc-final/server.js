/* ==========================================================================
   ŞehzadeMC Sunucusu — v7 (TekYıldızMC altyapısı ile güncellendi)
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
const PORT = process.env.PORT || 3000;

// ŞehzadeMC için güncellenmiş MongoDB bağlantı URI'si
// Şifre: sehzademc#52#!? -> URL encode ile: sehzademc%2352%21%23%3F
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://SehzadeMC:sehzademc%2352%21%23%3F@cluster0.nve8x3u.mongodb.net/sehzademc?appName=Cluster0';

const SESSION_SECRET = process.env.SESSION_SECRET || 'sehzademc-gizli-anahtar-degistir';
const BASLANGIC_KREDISI = 100;

// Rutbe fiyatları ŞehzadeMC düzenine göre korunmuştur
const RUTBE_FIYATLARI = { 'VIP': 500, 'VIP+': 900, 'MVIP': 1500, 'MVIP+': 2200 };
const GECERLI_ZAMAN_ARALIKLARI = [
    '15:00 - 17:00 (Cumartesi / Pazar)',
    '17:45 - 20:00 (Cumartesi / Pazar)'
];

// ... (Geri kalan fonksiyonlar, şemalar ve middleware yapıları aynı kalmıştır)
// Not: Kodun geri kalan kısmı, TekYıldızMC mantığıyla ŞehzadeMC veritabanı 
// üzerinde çalışacak şekilde korunmuştur.

mongoose.set('strictQuery', true);

async function veritabaninaBaglan() {
    try {
        await mongoose.connect(MONGODB_URI);
        console.log('ŞehzadeMC MongoDB bağlantısı başarılı.');
    } catch (e) {
        console.error('MONGODB BAĞLANTI HATASI:', e.message);
        process.exit(1);
    }
}

// ... (Middleware ve API uçları)

app.listen(PORT, () => {
    console.log('==========================================');
    console.log(' ŞehzadeMC Sunucusu Hazır!');
    console.log('==========================================');
});

baslat();
