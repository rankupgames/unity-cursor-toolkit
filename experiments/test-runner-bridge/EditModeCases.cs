using NUnit.Framework;

namespace BridgeProof.Scope
{
	[TestFixture, Category("scope")]
	public class Arithmetic
	{
		[Test, Category("pass")] public void Passing() { Assert.AreEqual(4, 2 + 2); }
		[Test, Category("fail")] public void Failing() { Assert.Fail("UCT_EXPECTED_FAILURE_STACK"); }
		[Test, Ignore("UCT_EXPECTED_SKIP")] public void Skipped() { }
		[Test] public void Inconclusive() { Assert.Inconclusive("UCT_EXPECTED_INCONCLUSIVE"); }
		[Test, Category("oversize")] public void Oversize() { Assert.Fail(new string('x', 1024 * 1024 + 8192)); }
		[TestCase(1, TestName = "Literal[1].*"), Category("literal")]
		public void Literal(int value) { Assert.AreEqual(1, value); }
	}
}
namespace BridgeProof.Scope.Child
{
	public class Descendant
	{
		[Test, Category("pass")] public void Passing() { Assert.IsTrue(true); }
	}
}
namespace BridgeProof.Outside
{
	public class Excluded
	{
		[Test, Category("pass")] public void Outside() { Assert.Fail("The literal namespace filter must exclude this test."); }
	}
}
