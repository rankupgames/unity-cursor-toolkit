using System;
using System.IO;
using NUnit.Framework;

namespace BridgeProof.Scope
{
	public class Arithmetic
	{
		[Test, Category("slow")]
		public void Passing()
		{
			File.WriteAllText(Path.Combine(Environment.GetEnvironmentVariable("UCT_TEST_BRIDGE_PROOF"), "unexpected-cross-assembly"), "unselected");
			Assert.Fail("UCT_UNSELECTED_CROSS_ASSEMBLY_TEST_EXECUTED");
		}
	}
	public class Other
	{
		[Test, Category("pass")] public void Passing() { Assert.IsTrue(true); }
	}
}
