using System.Text;
using System.Text.Json;
using Xunit;

namespace SheetAgent.Companion.Tests;

public sealed class CustomFunctionsContractTests
{
    // Regression: the add-in (HttpCustomFunctionGateway) serializes camelCase bodies.
    // Default System.Text.Json is case-sensitive and expects PascalCase, which made every
    // /v1/custom-functions call fail with INVALID_BATCH and show #AI! in the cell.
    [Fact]
    public void Deserializes_the_camelCase_body_the_addin_sends()
    {
        var body = Encoding.UTF8.GetBytes(
            "{\"requests\":[{\"functionName\":\"AI.SUMMARIZE\",\"input\":\"Revenue rose from 10 to 12\"}]}");

        var batch = JsonSerializer.Deserialize<CustomFunctionBatch>(body, Program.WebJson);

        Assert.NotNull(batch);
        Assert.Single(batch!.Requests);
        Assert.Equal("AI.SUMMARIZE", batch.Requests[0].FunctionName);
        Assert.Equal("Revenue rose from 10 to 12", batch.Requests[0].Input);
    }

    [Fact]
    public void Still_accepts_PascalCase_bodies()
    {
        var body = Encoding.UTF8.GetBytes(
            "{\"Requests\":[{\"FunctionName\":\"AI\",\"Input\":\"x\"}]}");

        var batch = JsonSerializer.Deserialize<CustomFunctionBatch>(body, Program.WebJson);

        Assert.Equal("AI", batch!.Requests[0].FunctionName);
    }
}
