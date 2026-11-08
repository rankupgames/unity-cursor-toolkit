using NUnit.Framework;

public class CliEditTests
{
    [Test] public void Passing() { Assert.That(2 + 2, Is.EqualTo(4)); }
    [Test] public void DeliberateFailure() { Assert.Fail("CLI_PROOF_EXPECTED_FAILURE"); }
}
