from desktop.automation.retry import RetryEngine

retry = RetryEngine()

count = 0


def test():

    global count

    count += 1

    print(

        "Attempt",

        count

    )

    return count == 3


print(

    retry.retry(

        test

    )

)