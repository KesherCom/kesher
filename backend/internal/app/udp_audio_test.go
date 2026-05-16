package app

import (
	"bytes"
	"testing"
)

func TestUDPAudioPacketRoundTrip(t *testing.T) {
	cases := []UDPAudioPacket{
		{
			Flags:     udpFlagAudio,
			Sequence:  0xABCD,
			Timestamp: 0x12345678,
			TokenHash: 0xDEADBEEF,
			Payload:   []byte{1, 2, 3, 4, 5},
		},
		{
			Flags:     udpFlagRegister,
			Sequence:  0,
			Timestamp: 0,
			TokenHash: 0xCAFEBABE,
			Payload:   []byte("session-token-12345"),
		},
		{
			Flags:     udpFlagHeartbeat,
			Sequence:  1,
			Timestamp: 4242,
			TokenHash: 0,
			Payload:   nil,
		},
	}
	for i, want := range cases {
		buf := make([]byte, udpAudioHeaderLen+len(want.Payload))
		n, err := EncodeUDPAudioPacket(buf, want)
		if err != nil {
			t.Fatalf("case %d: encode error: %v", i, err)
		}
		if n != udpAudioHeaderLen+len(want.Payload) {
			t.Fatalf("case %d: encoded length %d, want %d", i, n, udpAudioHeaderLen+len(want.Payload))
		}
		got, err := DecodeUDPAudioPacket(buf[:n])
		if err != nil {
			t.Fatalf("case %d: decode error: %v", i, err)
		}
		if got.Flags != want.Flags || got.Sequence != want.Sequence ||
			got.Timestamp != want.Timestamp || got.TokenHash != want.TokenHash {
			t.Fatalf("case %d: header mismatch got=%+v want=%+v", i, got, want)
		}
		if !bytes.Equal(got.Payload, want.Payload) {
			t.Fatalf("case %d: payload mismatch", i)
		}
	}
}

func TestUDPAudioPacketRejectsBadMagic(t *testing.T) {
	buf := make([]byte, udpAudioHeaderLen)
	copy(buf[0:4], "XXXX")
	buf[4] = udpAudioVersion
	if _, err := DecodeUDPAudioPacket(buf); err == nil {
		t.Fatalf("expected bad-magic decode to fail")
	}
}

func TestUDPAudioPacketRejectsShort(t *testing.T) {
	if _, err := DecodeUDPAudioPacket(make([]byte, udpAudioHeaderLen-1)); err == nil {
		t.Fatalf("expected short-packet decode to fail")
	}
}

func TestHashSessionTokenStable(t *testing.T) {
	a := HashSessionToken("hello")
	b := HashSessionToken("hello")
	if a != b {
		t.Fatalf("HashSessionToken not stable: %d != %d", a, b)
	}
	if HashSessionToken("hello") == HashSessionToken("world") {
		t.Fatalf("HashSessionToken should differ for different inputs")
	}
}
