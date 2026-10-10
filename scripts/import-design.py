"""Copy only static, reviewed design references; never execute handoff scripts."""
from pathlib import Path, PurePosixPath
import stat
import zipfile

root = Path(__file__).resolve().parent.parent
with zipfile.ZipFile(root / 'sanxing-design-handoff.zip') as archive:
    for info in archive.infolist():
        name = PurePosixPath(info.filename)
        if name.is_absolute() or '..' in name.parts or not name.parts or name.parts[0] != 'sanxing-design-handoff':
            raise ValueError(f'Unsafe archive path: {name}')
        if stat.S_ISLNK(info.external_attr >> 16):
            raise ValueError(f'Archive symlink is not allowed: {name}')
        if info.is_dir() or name.suffix not in {'.md', '.css', '.json', '.png'} or 'figma-plugin' in name.parts:
            continue
        if info.file_size > 2_000_000:
            raise ValueError(f'Design reference too large: {name}')
        target = root / 'design' / str(name)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(archive.read(info))
print('Imported static references into design/sanxing-design-handoff; no handoff code was executed.')
