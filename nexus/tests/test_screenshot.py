from desktop.screenshot import ScreenshotController

shot = ScreenshotController()

image = shot.capture()

print(image.size)

shot.save("desktop_test.png")

print("Saved")