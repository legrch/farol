import { crc32 } from "node:zlib";

// Stored ZIP fixture for the system reader, not a vendor archive or executable.
export function syntheticTunnelArchive() {
  const binary = Buffer.alloc(1024);
  binary.writeUInt32LE(0xfeedfacf);
  binary.writeUInt32LE(0x0100000c, 4);
  const entries = [
    ["tunnel-client", binary],
    ["LICENSE", Buffer.from("fixture license\n")],
    ["NOTICE", Buffer.from("fixture notice\n")],
    ["unselected/unused", Buffer.from("never extracted\n")],
  ];
  const local = [],
    central = [];
  let offset = 0;
  for (const [name, bytes] of entries) {
    const label = Buffer.from(name),
      crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(label.length, 26);
    local.push(header, label, bytes);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(bytes.length, 20);
    record.writeUInt32LE(bytes.length, 24);
    record.writeUInt16LE(label.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, label);
    offset += header.length + label.length + bytes.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
