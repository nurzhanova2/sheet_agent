using Xunit;
using SheetAgent.Companion;

namespace SheetAgent.Companion.Tests;

public sealed class PairingServiceTests
{
    [Fact]
    public void Pairing_code_is_single_use_and_rotates()
    {
        var service = new PairingService();
        var code = service.CurrentCode;
        var token = service.Exchange(code);
        Assert.NotNull(token);
        Assert.NotEqual(code, service.CurrentCode);
        Assert.Null(service.Exchange(code));
        Assert.True(service.ValidateToken(token!));
    }

    [Fact]
    public void Invalid_code_and_token_are_rejected()
    {
        var service = new PairingService();
        Assert.Null(service.Exchange("invalid"));
        Assert.False(service.ValidateToken("invalid"));
    }
}

