from app.translit import has_arabic_script, urdu_to_devanagari as t


def test_common_words_and_sentence():
    assert t("آپ کا آرڈر تیار ہے۔") == "आप का ऑर्डर तयार है।"
    assert t("شکریہ") == "शुक्रिया"
    assert t("میں ٹھیک ہوں") == "में ठीक हों"


def test_letter_rules():
    assert t("کام") == "काम"
    assert t("بھائی") == "भाई"
    assert t("گھر") == "घर"
    assert t("ایک") == "एक"
    assert t("کو") == "को"
    assert t("سے") == "से"
    assert t("کی") == "की"
    assert t("آیا") == "आया"
    assert t("بچہ") == "बचा"


def test_digits_and_latin_pass_through():
    assert t("قیمت ۱۲۰۰ روپے") == "क़ीमत 1200 रुपये"
    assert t("Order #12 تیار") == "Order #12 तयार"


def test_no_arabic_left():
    out = t("السلام علیکم، آپ کا آرڈر کل صبح تک پہنچ جائے گا۔ شکریہ!")
    assert not has_arabic_script(out)
