"""Synthetic fixtures (no real people or documents). Run in the service image as root with fonts-dejavu-core,
with the output folder mounted at /out. The committed copies live in tests/fixtures/ocr."""
from PIL import Image, ImageDraw, ImageFont
F = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
def page(lines, name, size=(1600, 1100), fs=44, fmt="PNG"):
    img = Image.new("RGB", size, "white"); d = ImageDraw.Draw(img); f = ImageFont.truetype(F, fs)
    y = 60
    for line in lines:
        d.text((70, y), line, font=f, fill="black"); y += int(fs * 1.7)
    img.save("/out/" + name, fmt)
    return img
ru = ["Водитель: Иванов Иван Иванович", "Телефон водителя: +7 701 123 45 67", "Гос.номер авто: 754BA04", "Марка авто: SCANIA",
      "Гос.номер прицепа: 66DLA04", "Марка прицепа: SCHMITZ S.KO 24/1", "Перевозчик: ТОО Рокос"]
page(ru, "ru.png")
page(["Водитель: Әбдірахманов Қайрат Ұлықбекұлы", "Телефон водителя: 8 (701) 123-45-67", "Гос.номер авто: 044WST04", "Марка авто: ГАЗ 27055"], "kaz.jpg", fmt="JPEG")
img = page(ru, "scan_src.png"); img.save("/out/scan.pdf", "PDF", resolution=150)
page(["Водитель:", "Гос.номер авто:", "Марка авто:", "Гос.номер прицепа:", "Марка прицепа:", "Телефон водителя:"], "empty_fields.png")
page(["ФИО водителя", "Номер а/м, п/п", "Телефон водителя", "Перевозчик"], "labels_only.png")
# imitation of the reverse side of a Kazakhstan identity card (layout zones used by the service)
W, H = 1600, 1000
card = Image.new("RGB", (W, H), "white"); d = ImageDraw.Draw(card)
f = ImageFont.truetype(F, 40); big = ImageFont.truetype(F, 54)
d.text((60, 40), "ҚАЗАҚСТАН РЕСПУБЛИКАСЫ / РЕСПУБЛИКА КАЗАХСТАН", font=f, fill="black")
d.text((60, 100), "ЖЕКЕ КУӘЛІК / УДОСТОВЕРЕНИЕ ЛИЧНОСТИ", font=f, fill="black")
y = 160
for line in ["ТЕГІ / ФАМИЛИЯ", "ТОЛЫБАЙ", "АТЫ / ИМЯ", "АНУАР", "ӘКЕСІНІҢ АТЫ / ОТЧЕСТВО", "СЕРІКБОЛАТҰЛЫ"]:
    d.text((int(W * 0.36), y), line, font=f, fill="black"); y += 60
d.text((int(W * 0.64), int(H * 0.44)), "123456789", font=big, fill="black")
card.save("/out/idcard.png")
print("generated")
