from .models import WebsiteInfo


class WebsiteRegistry:

    def __init__(self):

        self.websites = [

            WebsiteInfo(

                name="Google",

                aliases=(

                    "google",

                ),

                url="https://www.google.com",

                search_box='textarea[name="q"]'

            ),

            WebsiteInfo(

                name="Amazon India",

                aliases=(

                    "amazon",

                    "amazon.in"

                ),

                url="https://www.amazon.in",

                search_box="#twotabsearchtextbox"

            ),

            WebsiteInfo(

                name="Flipkart",

                aliases=(

                    "flipkart",

                ),

                url="https://www.flipkart.com",

                search_box='input[name="q"]'

            )

        ]

    def get(

        self,

        name: str

    ):

        name = name.lower()

        for website in self.websites:

            if name == website.name.lower():

                return website

            if name in website.aliases:

                return website

        return None