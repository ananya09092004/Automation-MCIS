from perception import Screen

screen = Screen()

frame = screen.capture()

print(frame.width)

print(frame.height)

screen.save(

    "screen.png"

)

print("Done")