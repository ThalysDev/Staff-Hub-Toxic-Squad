Add-Type -AssemblyName System.Drawing
$base = 'C:SERSSURIO~2ZCODE~1WORKSP~1DEFAULTSTAFF-~1SRCENDERERSSETSBRAND'
$src = [System.Drawing.Image]::FromFile("$base\logo.png")
$side = [Math]::Min($src.Width, $src.Height)
$x = [int](($src.Width - $side) / 2)
$y = [int](($src.Height - $side) / 2)
$bmp = New-Object System.Drawing.Bitmap(256, 256)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$dest = New-Object System.Drawing.Rectangle(0, 0, 256, 256)
$srcRect = New-Object System.Drawing.Rectangle($x, $y, $side, $side)
$g.DrawImage($src, $dest, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$bmp.Save("$base\logo-256.png", [System.Drawing.Imaging.ImageFormat]::Png)
$src.Dispose()
Write-Output 'logo-256 ok'
