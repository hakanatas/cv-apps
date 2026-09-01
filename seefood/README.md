# Ayır & Öğren 🧠 (Seefood'un eğitim sürümü)

El hareketleriyle kartları doğru kutuya sürükleyerek öğrenme oyunu. collidingScopes'un "Seefood" (Hot Dog / Not Hot Dog) demosu üzerine kuruldu; orijinal mekanik korunup üstüne kategori setleri, doğruluk kontrolü, puanlama ve Türkçe sesli geri bildirim eklendi.

## Nasıl oynanır

- **Bir elini aç**: kart çemberi avucunda belirir; parmaklarını aç/kapa → çember büyür/küçülür
- **Diğer elinle kartı tut** (baş + işaret parmağını birleştir), kutuya sürükle, bırak
- **Doğru kutu**: yıldız patlaması, puan, seri bonusu ve kartın adı Türkçe okunur ("Elma — meyve!")
- **Yanlış kutu**: kart çembere geri döner, açıklama okunur ("Hayır — Havuç bir sebze!")
- Tur 8 karttan oluşur; sonunda puan/istatistik ekranı ve yeni set seçimi

## Setler (`sets.js`)

| Set | Kategoriler |
|---|---|
| Meyve mi, Sebze mi? | MEYVE / SEBZE |
| Canlı mı, Cansız mı? | CANLI / CANSIZ |
| Memeli mi, Kuş mu? | MEMELİ / KUŞ |
| Tek mi, Çift mi? | TEK SAYI / ÇİFT SAYI (her tur yeni sayılar) |
| Sesli mi, Sessiz mi? | SESLİ HARF / SESSİZ HARF |
| İngilizce: Animal or Food? | ANIMAL / FOOD (İngilizce kelime okunur, Türkçe anlamı söylenir) |
| Hot Dog mu, Değil mi? | Orijinal set (görsel kartlar) |

Yeni set eklemek için `sets.js`'e bir giriş eklemek yeterli: emoji, metin veya görsel kartlar; kartlar çalışma anında canvas'a çizilir, görsel dosyası gerekmez.

## Dosyalar

- `game.js` — el takibi, kart çemberi, sürükle-bırak, puanlama, tur akışı
- `sets.js` — kategori setleri ve tur oluşturma
- `effects.js` — ses efektleri (WebAudio) ve Türkçe/İngilizce sesli okuma
- `index.html` / `styles.css` — Türkçe arayüz, başlangıç ve sonuç ekranları

## Çalıştırma

```bash
cd seefood
python3 -m http.server 8000
# http://localhost:8000
```

Kamera erişimi gerekir (internette HTTPS şart).

## Teşekkür

Orijinal fikir ve mekanik: [funwithcomputervision.com](https://www.funwithcomputervision.com/) · Hot dog görselleri: [thiings.co](https://www.thiings.co)
