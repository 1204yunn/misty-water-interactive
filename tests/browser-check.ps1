param([string[]]$TestName=@('photo'), [string]$BaseUrl='')
$ErrorActionPreference='Stop'
$workspace=Split-Path -Parent $PSScriptRoot
$chrome='C:\Program Files\Google\Chrome\Application\chrome.exe'
foreach($test in $TestName) {
  $profile=Join-Path $env:TEMP ('misty-live-check-'+[guid]::NewGuid().ToString('N'))
  $process=$null; $socket=$null
  try {
    $process=Start-Process -FilePath $chrome -WindowStyle Hidden -PassThru -ArgumentList @(
      '--headless','--no-first-run','--no-default-browser-check','--enable-unsafe-swiftshader',
      '--allow-file-access-from-files','--disable-background-timer-throttling',
      '--remote-debugging-port=0',"--user-data-dir=$profile",'about:blank')
    $portFile=Join-Path $profile 'DevToolsActivePort'
    $started=[DateTime]::UtcNow
    while(!(Test-Path -LiteralPath $portFile)) {
      if(([DateTime]::UtcNow-$started).TotalSeconds -gt 15){throw 'Chrome debugger startup timed out'}
      Start-Sleep -Milliseconds 100
    }
    $port=([IO.File]::ReadAllLines($portFile))[0]
    $tabs=Invoke-RestMethod "http://127.0.0.1:$port/json/list"
    $tab=$tabs | Where-Object type -eq 'page' | Select-Object -First 1
    $socket=[Net.WebSockets.ClientWebSocket]::new()
    $null=$socket.ConnectAsync([uri]$tab.webSocketDebuggerUrl,[Threading.CancellationToken]::None).GetAwaiter().GetResult()
    $script:callId=0
    function Invoke-CDP($method,$parameters) {
      $script:callId++
      $id=$script:callId
      $payload=@{id=$id;method=$method;params=$parameters}|ConvertTo-Json -Depth 12 -Compress
      $bytes=[Text.Encoding]::UTF8.GetBytes($payload)
      $null=$socket.SendAsync([ArraySegment[byte]]::new($bytes),[Net.WebSockets.WebSocketMessageType]::Text,$true,[Threading.CancellationToken]::None).GetAwaiter().GetResult()
      $timeout=[Threading.CancellationTokenSource]::new(85000)
      try {
        while($true) {
          $stream=[IO.MemoryStream]::new()
          do {
            $buffer=[byte[]]::new(65536)
            $received=$socket.ReceiveAsync([ArraySegment[byte]]::new($buffer),$timeout.Token).GetAwaiter().GetResult()
            if($received.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close){throw 'Chrome debugger closed'}
            $stream.Write($buffer,0,$received.Count)
          } while(!$received.EndOfMessage)
          $message=[Text.Encoding]::UTF8.GetString($stream.ToArray())|ConvertFrom-Json
          $stream.Dispose()
          if($message.id -eq $id) {
            if($message.error){throw ($message.error|ConvertTo-Json -Compress)}
            return $message.result
          }
        }
      } finally {$timeout.Dispose()}
    }
    $null=Invoke-CDP 'Page.enable' @{}
    $url=if($BaseUrl){$BaseUrl.TrimEnd('/')+"/tests/$test.html"}else{([uri](Join-Path $workspace "tests/$test.html")).AbsoluteUri}
    $null=Invoke-CDP 'Page.navigate' @{url=$url}
    Start-Sleep -Milliseconds 500
    $expression=@'
new Promise(resolve=> {
  const start=performance.now();
  const timer=setInterval(()=> {
    const text=document.getElementById('result')?.textContent || '';
    if(text.includes('ALL CHECKS PASSED') || text.includes('FAIL') || performance.now()-start>70000) {
      clearInterval(timer);resolve(text);
    }
  },100);
})
'@
    $result=Invoke-CDP 'Runtime.evaluate' @{expression=$expression;awaitPromise=$true;returnByValue=$true}
    $text=$result.result.value
    Write-Output "Test: $test"
    Write-Output $text
    if(!$text.Contains('ALL CHECKS PASSED')){throw "$test checks did not pass"}
  } finally {
    if($socket){$socket.Dispose()}
    if($process -and !$process.HasExited){Stop-Process -Id $process.Id -ErrorAction SilentlyContinue}
  }
}
