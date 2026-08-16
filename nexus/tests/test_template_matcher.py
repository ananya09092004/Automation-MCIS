from PIL import Image, ImageDraw

from perception.vision import TemplateMatcher


def test_template_matcher_finds_a_reference_icon(tmp_path):
    screen = Image.new("RGB", (180, 120), "white")
    icon = Image.new("RGB", (20, 20), "white")
    ImageDraw.Draw(icon).ellipse((2, 2, 17, 17), fill="blue")
    screen.paste(icon, (80, 40))
    template_path = tmp_path / "icon.png"
    icon.save(template_path)

    match = TemplateMatcher().find(screen, str(template_path), minimum_confidence=0.99)

    assert match is not None
    assert (match.x, match.y) == (90, 50)
