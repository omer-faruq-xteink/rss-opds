# rss-opds (Türkçe rehber)

CommaFeed RSS hesabınızı bir **OPDS kataloğu** olarak yayınlayan, **Cloudflare Workers ücretsiz planında** çalışan küçük bir uygulama. Her yazı, e-okuyucunuzun doğrudan indirebileceği bir **EPUB** olarak sunulur. Xteink X4 / X4 Pro (stok "XT Licorice" yazılımı), CrossPoint, KOReader ve OPDS destekleyen diğer okuyucularla kullanılabilir.

*English: [README.md](README.md)*

```
E-okuyucu  ──OPDS/HTTPS──▶  Cloudflare Worker  ──API key──▶  CommaFeed
(Xteink…)   ◀── EPUB ──────  (bu proje)         ◀── JSON ────  (commafeed.com veya kendi sunucunuz)
```

- Sunucu, veritabanı, cron yok: her istek anında CommaFeed'den okunur ve EPUB bellekte üretilir.
- Ücretsiz plan sınırı günde 100.000 istek, istek başına 10 ms CPU; bir yazının EPUB'u bunun çok altında kalır.
- Katalog HTTP Basic auth (kullanıcı adı / şifre) ile korunur; isterseniz şifre yerine URL'ye gömülü gizli bir anahtar da kullanabilirsiniz.

## Katalog yapısı

| Yol | İçerik |
|---|---|
| `/opds` | Kök menü (aşağıdakilere bağlantılar) |
| `/opds/unread` | Okunmamış yazılar, en yeni önce (sayfalı) |
| `/opds/starred` | Yıldızlı yazılar |
| `/opds/all` | Son yazılar (okunmuş dahil) |
| `/opds/categories` → `/opds/category/<id>` | Kategoriye göre |
| `/opds/feeds` → `/opds/feed/<id>` | Kaynağa göre |
| `/opds/search?q=kelime` | Arama (OpenSearch tanımı: `/opds/search.xml`) |
| `/book/<id>/<baslik>.epub` | Yazının EPUB'u |

Kategori/kaynak listeleri varsayılan olarak okunmamışları gösterir; `?read=all` ekleyince tümü gelir. Menü desteği zayıf okuyucularda doğrudan `/opds/unread` adresini katalog olarak ekleyebilirsiniz.

Görseller: `?images=1` görselleri EPUB'a gömer, `?images=0` yalnızca metin verir (hızlı). Parametre tüm bağlantılara taşınır; yani aynı Worker'ı cihaza iki katalog olarak ekleyebilirsiniz: `.../opds?images=0` (hızlı) ve `.../opds?images=1` (görselli). Parametre yoksa `INCLUDE_IMAGES` ayarı geçerlidir.

## Kurulum (10 dakika)

### 1. CommaFeed API anahtarı

CommaFeed web arayüzünde sağ üstteki profil menüsünden **Settings → Profile** sayfasını açın; **API key** alanındaki üret (generate) düğmesine basıp anahtarı kopyalayın. Anahtar yalnızca okuma ve "okundu işaretleme" için kullanılır; şifreniz hiçbir yere yazılmaz. Not: CommaFeed, şifrenizi değiştirdiğinizde yeni bir API anahtarı üretir; o zaman Worker'daki secret'ı da güncelleyin.

Alternatif: API anahtarı yerine CommaFeed kullanıcı adı ve şifrenizi `COMMAFEED_USER` / `COMMAFEED_PASSWORD` secret'ları olarak verebilirsiniz (KOReader RSS eklentisinin kullandığı yöntemle aynı). Çalışır, ama anahtar yöntemi daha güvenlidir: sızarsa yalnızca anahtarı yenilersiniz.

### 2. Cloudflare hesabı

[dash.cloudflare.com](https://dash.cloudflare.com) üzerinden ücretsiz bir hesap açın (kredi kartı gerekmez). Workers ücretsiz planı bu proje için yeterlidir.

### 3A. Komut satırıyla yayınlama (önerilen)

Node.js 18+ kurulu olmalı.

```bash
git clone https://github.com/omer-faruq-xteink/rss-opds.git
cd rss-opds
npm install
npx wrangler login
npx wrangler secret put COMMAFEED_API_KEY
npx wrangler secret put OPDS_USER
npx wrangler secret put OPDS_PASS
npx wrangler deploy
```

`wrangler deploy` sonunda `https://commafeed-opds.<hesap>.workers.dev` gibi bir adres yazdırır. Katalog adresiniz: **`https://commafeed-opds.<hesap>.workers.dev/opds`**

Tarayıcıda `/health` yolunu açınca `ok` görmelisiniz; `/opds` yolunu açınca tarayıcı kullanıcı adı/şifre sorar ve XML kataloğu gösterir.

### 3B. Komut satırı olmadan (Cloudflare panelinden)

1. Bu depoyu GitHub'da kendi hesabınıza fork'layın.
2. Cloudflare panelinde **Workers & Pages → Create → Import a repository** ile fork'u seçin. Build ayarlarında deploy komutu `npx wrangler deploy` olmalı (varsayılan).
3. Worker oluştuktan sonra **Settings → Variables and Secrets** altında şu üç **secret**'ı ekleyin: `COMMAFEED_API_KEY`, `OPDS_USER`, `OPDS_PASS`. Kaydedip tekrar deploy edin.

### 4. E-okuyucuya ekleme

**Xteink X4 / X4 Pro (stok yazılım, "XT Licorice" ve sonrası):**
Ayarlar → Wi-Fi'ye bağlanın → **OPDS catalog list → Add catalog**:

- Name: `CommaFeed`
- Catalog URL: `https://commafeed-opds.<hesap>.workers.dev/opds`
- "Account and password" bölümünü açın: `OPDS_USER` / `OPDS_PASS` değerleri
- **Test** → **Save**

**CrossPoint (1.3+):** Settings → Connectivity → OPDS Servers → Add Server; aynı URL ve kullanıcı adı/şifre (ikisini de doldurun; şifre boş kalırsa kullanıcı adı gönderilmez).

**KOReader:** Search → OPDS catalog → + ; URL, kullanıcı adı, şifre.

Bir yazıyı seçip indirin; cihazın kitaplığında `Kaynak-Basligi.epub` olarak görünür.

## Tam metin (sanitizer) desteği

Feed çoğu zaman yalnızca özet taşır. İsterseniz Worker, EPUB'ı üretmeden önce yazının adresini bir "tam metin" servisine gönderip temiz, tam makaleyi alır (KOReader RSS eklentisindeki sanitizer mantığının aynısı). Sırayla denenir; biri başarısız olursa sonrakine geçilir, hepsi başarısız olursa feed içeriği kullanılır. Sonuç 24 saat önbelleğe alınır; aynı yazı iki kez indirilirse servise tekrar gidilmez.

| Servis | Secret | Nasıl alınır |
|---|---|---|
| Instaparser | `INSTAPARSER_TOKEN` | [instaparser.com](https://www.instaparser.com) hesabı, API token |
| Diffbot | `DIFFBOT_TOKEN` | [diffbot.com](https://www.diffbot.com) hesabı, API token |
| Instapaper | `INSTAPAPER_TOKEN` | [instapaper.com/developers/applications](https://www.instapaper.com/developers/applications) kişisel erişim token'ı. Yazı önce hesaba kaydedilir, ayrıştırılmış metni okunur, sonra silinir; bu iş için ayrı bir Instapaper hesabı kullanmanız önerilir |

- `SANITIZERS` değişkeni deneme sırasını belirler (varsayılan `instaparser,diffbot,instapaper`); token'ı olmayan servis atlanır.
- `FULLTEXT=true` ile tam metin varsayılan olur. Cihaz başına seçmek için katalog URL'sine `?full=1` / `?full=0` ekleyin; kök menüde "Tam metin / Özet" geçişi de vardır. `?images=1` ile birleştirilebilir: `.../opds?full=1&images=1`.
- Ücretli kotaları olan servislerde (Instaparser deneme planı, Diffbot ücretsiz plan) her indirme bir çağrı harcar; indirme önbelleği sayesinde aynı yazı tekrar harcamaz.
- Gelişmiş: `INSTAPARSER_ENDPOINT`, `DIFFBOT_ENDPOINT`, `DIFFBOT_TIMEOUT_MS`, `DIFFBOT_MODE`, `INSTAPAPER_API_BASE` değişkenleriyle uç noktalar değiştirilebilir (test ve kendi kurulumlarınız için).

## Ayarlar

`wrangler.toml` içindeki `[vars]` bölümünden (veya panelden) değiştirilebilir:

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `COMMAFEED_URL` | `https://www.commafeed.com` | Kendi CommaFeed sunucunuz varsa adresi |
| `CATALOG_TITLE` | `CommaFeed` | Cihazda görünen katalog adı |
| `PAGE_SIZE` | `30` | Sayfa başına yazı (en fazla 60) |
| `INCLUDE_IMAGES` | `false` | Varsayılan görsel davranışı: `true` ise yazı görselleri EPUB'a gömülür (daha yavaş, daha büyük dosya). Cihaz başına değiştirmek için katalog URL'sine `?images=1` veya `?images=0` ekleyin; kök menüde de "Görselli / Görselsiz" geçişi vardır |
| `MAX_IMAGES` | `8` | Yazı başına en fazla görsel |
| `MARK_READ_ON_DOWNLOAD` | `false` | `true` ise indirilen yazı CommaFeed'de okundu işaretlenir |
| `LANG` | `tr` | EPUB dil etiketi (tireleme için) |
| `FULLTEXT` | `false` | Varsayılan tam metin davranışı (`?full=1/0` ile URL başına değişir) |
| `SANITIZERS` | `instaparser,diffbot,instapaper` | Tam metin servislerinin deneme sırası |

Secret'lar (`wrangler secret put` ile):

| Secret | Zorunlu | Açıklama |
|---|---|---|
| `COMMAFEED_API_KEY` | biri** | CommaFeed API anahtarı (önerilen) |
| `COMMAFEED_USER`, `COMMAFEED_PASSWORD` | biri** | Alternatif: CommaFeed kullanıcı adı ve şifresi (Basic auth) |
| `OPDS_USER`, `OPDS_PASS` | biri* | Kataloğun Basic auth kullanıcı adı ve şifresi |
| `OPDS_TOKEN` | biri* | Alternatif: katalog `https://…/k/<OPDS_TOKEN>/opds` adresinde şifresiz açılır |
| `INSTAPARSER_TOKEN`, `DIFFBOT_TOKEN`, `INSTAPAPER_TOKEN` | hayır | Tam metin servisleri (bkz. yukarı) |

\* En az bir koruma yöntemi ayarlanmalıdır; ikisi birden de olabilir. Token yöntemi, kullanıcı adı/şifre gönderemeyen okuyucular içindir; URL'yi paylaşmayın.
\*\* API anahtarı veya kullanıcı adı + şifre; ikisi de verilirse kullanıcı adı/şifre kullanılır.

## Yerel geliştirme ve test

```bash
npm test                      # çevrimdışı birim testleri (HTML→XHTML, EPUB, OPDS XML)
cp .dev.vars.example .dev.vars   # gerçek API anahtarınızı yazın
npm run dev                   # http://127.0.0.1:8787/opds
```

Gerçek hesap olmadan uçtan uca denemek için sahte bir CommaFeed sunucusu var:

```bash
node test/mock-commafeed.mjs 8790
npx wrangler dev --var COMMAFEED_URL:http://127.0.0.1:8790   # .dev.vars içinde COMMAFEED_API_KEY="testkey"
```

Sanitizer zincirini de sahte servislerle denemek için (`.dev.vars` içinde `INSTAPARSER_TOKEN="ip-token"`, `DIFFBOT_TOKEN="db-token"`, `INSTAPAPER_TOKEN="pp-token"`):

```bash
node test/mock-sanitizers.mjs 8791
npx wrangler dev --var COMMAFEED_URL:http://127.0.0.1:8790 --var INSTAPARSER_ENDPOINT:http://127.0.0.1:8791/instaparser/api/1/article --var DIFFBOT_ENDPOINT:http://127.0.0.1:8791/diffbot/v3/analyze --var INSTAPAPER_API_BASE:http://127.0.0.1:8791/instapaper/api/2
```

Windows'ta `wrangler dev` "SQLITE_CANTOPEN" verirse proje yolu çok uzundur; `--persist-to C:\Temp\wrangler-state` ekleyin.

`.dev.vars` içindeki değerlerde `#` varsa (ör. şifre) değeri çift tırnak içine alın: `COMMAFEED_PASSWORD="ab#cd"`. Aksi halde `#` sonrası yorum sayılır ve CommaFeed 401 döner. `wrangler secret put` bu sorundan etkilenmez.

## Nasıl çalışıyor

- **Liste**: CommaFeed REST API (`/rest/category/entries`, `/rest/feed/entries`, `?apiKey=`) ile sayfa sayfa okunur ve OPDS 1.2 Atom "acquisition" feed'ine çevrilir. Girdi ID'leri `urn:commafeed:entry:<id>` biçimindedir.
- **EPUB**: Tek yazı, CommaFeed'in Google Reader uyumlu API'sinden (`stream/items/contents`, `Authorization: GoogleLogin auth=<apiKey>`) alınır. HTML, DOM'suz küçük bir dönüştürücüyle geçerli XHTML'e çevrilir (script/iframe/olay işleyicileri atılır, etiketler dengelenir). EPUB 3 paketi (EPUB 2 NCX ile birlikte) sıkıştırmasız ZIP olarak üretilir; ilk girdi `mimetype`'tır.
- **Okundu işaretleme**: API anahtarı modunda aynı API'nin `token` + `edit-tag` uçları, kullanıcı adı/şifre modunda `/rest/entry/mark` kullanılır.
- **Önbellek**: Üretilen EPUB 6 saat Cloudflare önbelleğinde tutulur (auth kontrolü her istekte yapılır).

## Sınırlamalar

- Sanitizer tanımlı değilse içerik, CommaFeed'in feed'den aldığı metindir; feed yalnızca özet veriyorsa EPUB'da da özet olur. Worker'ın kendi içinde Readability tarzı ayrıştırma ücretsiz planın 10 ms CPU sınırına sığmadığı için tam metin yalnızca dış servislerle alınır.
- Görseller varsayılan olarak alt metin olarak `[açıklama]` şeklinde gösterilir; `INCLUDE_IMAGES=true` ile gömülür.
- Cihazın OPDS istemcisi yönlendirme (redirect) ve menü (navigation) feed'lerini desteklemiyorsa doğrudan `/opds/unread` adresini kullanın.

## Yol haritası

- Dropbox / Yandex Disk / Google Drive klasöründeki EPUB'ları aynı katalogda sunma
- CrossPoint eklenti (plugin) desteği
- FiveFilters sanitizer'ı ve aylık çağrı kotası sayacı

## Lisans

MIT

