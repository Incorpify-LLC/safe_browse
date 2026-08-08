using System.Buffers.Binary;
using System.Text;

namespace SafeBrowse.Core;

public static class DnsMessage
{
    public static string ReadQuestionName(ReadOnlySpan<byte> packet)
    {
        if (packet.Length < 17 || BinaryPrimitives.ReadUInt16BigEndian(packet[4..]) == 0) throw new InvalidDataException("DNS question missing");
        var offset = 12; var labels = new List<string>();
        while (offset < packet.Length)
        {
            var length = packet[offset++];
            if (length == 0) break;
            if ((length & 0xc0) != 0 || length > 63 || offset + length > packet.Length) throw new InvalidDataException("Invalid DNS label");
            labels.Add(Encoding.ASCII.GetString(packet.Slice(offset, length))); offset += length;
        }
        if (labels.Count == 0 || offset + 4 > packet.Length) throw new InvalidDataException("Invalid DNS question");
        return DomainNormalizer.Normalize(string.Join('.', labels));
    }

    public static byte[] CreateBlockedResponse(ReadOnlySpan<byte> query)
    {
        var response = query.ToArray();
        if (response.Length < 12) throw new InvalidDataException("Invalid DNS packet");
        response[2] |= 0x80; // Set QR = 1 (Response)
        response[3] = (byte)((response[3] & 0x70) | 0x80 | 0x03); // Set RA = 1, RCODE = 3 (NXDOMAIN)
        response[6] = response[7] = response[8] = response[9] = response[10] = response[11] = 0;
        return response;
    }
}
