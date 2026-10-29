import unittest


class PackageTest(unittest.TestCase):
    def test_imports(self):
        import pipe2
        self.assertTrue(pipe2.__doc__)


if __name__ == "__main__":
    unittest.main()
