import time


class RetryEngine:

    def retry(

        self,

        func,

        retries=3,

        delay=1,

        *args,

        **kwargs

    ):

        last_result = None

        last_error = None

        for _ in range(retries):

            try:

                last_result = func(

                    *args,

                    **kwargs

                )

                if last_result:

                    return True

            except Exception as e:

                last_error = e

            time.sleep(delay)

        if last_error:

            raise last_error

        return False