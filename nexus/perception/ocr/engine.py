from rapidocr_onnxruntime import RapidOCR

from perception.ocr.models import OCRText


class OCREngine:

    def __init__(self):

        self.engine = RapidOCR()

    def read(self, image):

        result, _ = self.engine(image)

        items = []

        if result is None:

            return items

        for box, text, confidence in result:

            x1 = int(box[0][0])
            y1 = int(box[0][1])

            x2 = int(box[2][0])
            y2 = int(box[2][1])

            items.append(

                OCRText(

                    text=text,

                    confidence=float(confidence),

                    x1=x1,
                    y1=y1,
                    x2=x2,
                    y2=y2

                )

            )

        return items