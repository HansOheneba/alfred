"""Static architecture/build guards only; never execute the staged app."""
from pathlib import Path
import plistlib,re,unittest
ROOT=Path(__file__).resolve().parents[1]
class PolicyTests(unittest.TestCase):
 def test_declared_identity_and_exact_read_scope(self):
  info=plistlib.loads((ROOT/'Info.plist').read_bytes())
  ent=plistlib.loads((ROOT/'Collector.entitlements').read_bytes())
  self.assertEqual(info['CFBundleIdentifier'],'com.hansopoku.alfred.collector')
  self.assertEqual(ent,{'com.apple.security.app-sandbox':True,'com.apple.security.network.client':True,'com.apple.security.temporary-exception.files.home-relative-path.read-only':['/Library/Messages/chat.db','/Library/Messages/chat.db-wal','/Library/Messages/chat.db-shm']})
  self.assertIs(type(ent['com.apple.security.app-sandbox']),bool)
  self.assertIs(type(ent['com.apple.security.network.client']),bool)
 def test_prototype_does_not_advertise_unverified_older_macos(self):
  info=plistlib.loads((ROOT/'Info.plist').read_bytes())
  # The locally staged Mach-O was built with minos 27.0. An Info.plist claiming
  # 13.0 would not lower that binary requirement or establish older-OS support.
  self.assertEqual(info['LSMinimumSystemVersion'],'27.0')
 def test_no_runtime_sandbox_initializer(self):
  for source in (ROOT/'Sources').glob('*.swift'):
   self.assertNotIn('sandbox_init',source.read_text())
 def test_build_does_not_launch_or_install(self):
  script=(ROOT/'scripts/build.sh').read_text()
  self.assertNotRegex(script,r'(?m)^\s*(?:open|launchctl|osascript|tccutil|installer)\b')
  self.assertNotRegex(script,r'(?m)^\s*["\']?\$APP["\']?\s*(?:$|--)')
  self.assertNotIn('/Library/LaunchAgents',script)
  self.assertIn('codesign --verify --strict',script)
 def test_app_default_is_inactive(self):
  source=(ROOT/'Sources/AppMain.swift').read_text()
  block=source.split('if args.isEmpty {',1)[1].split('do { try command(args)',1)[0]
  for forbidden in ['MessageSource(', 'deliverHTTP(', 'saveNewConfig(', 'promptForExistingKey(', 'command(args)']:
   self.assertNotIn(forbidden,block)
  self.assertIn('try requireDeclaredSandbox()',source.split('func command(',1)[1].split('if args.first',1)[0])
  self.assertIn('Set(entitlements.keys)',source)
 def test_pure_fixture_build_excludes_app(self):
  script=(ROOT/'scripts/test.sh').read_text()
  self.assertNotIn('AppMain.swift',script)
  self.assertIn('CollectorTests.swift',script)
  self.assertNotIn('build/Alfred',script)
 def test_health_reporting_has_no_default_or_status_side_effect(self):
  source=(ROOT/'Sources/AppMain.swift').read_text()
  inactive=source.split('if args.isEmpty {',1)[1].split('do { try command(args)',1)[0]
  status=source.split('if args == ["--status"] {',1)[1].split('if args == ["--verify-account"]',1)[0]
  for block in [inactive,status]:
   self.assertNotIn('prepareCollectorHealthDevice(',block)
   self.assertNotIn('reportCollectorHealthBestEffort(',block)
  self.assertIn('let reportsHealth = args == ["--collect"] || args == ["--run"]',source)
  check=source.split('let reportsHealth =',1)[1].split('if args == ["--initialize"]',1)[0]
  self.assertIn('defer {',check)
  self.assertIn('reportCollectorHealthBestEffort(',check)
  health=(ROOT/'Sources/CollectorHealth.swift').read_text()
  report=health.split('func reportCollectorHealthBestEffort(',1)[1]
  self.assertIn('loadCollectorHealthDevice(',report)
  self.assertNotIn('prepareCollectorHealthDevice(',report)
  self.assertNotIn('store.capture(',report)
  self.assertNotIn('store.acknowledge(',report)
  self.assertIn('catch { return false }',report)
 def test_build_output_is_ignored(self):
  self.assertIn('build/',(ROOT/'.gitignore').read_text().splitlines())
 def test_automation_template_is_disabled_and_unresolved(self):
  job=plistlib.loads((ROOT/'LaunchAgent.plist.template').read_bytes())
  self.assertIs(job['Disabled'],True)
  self.assertEqual(job['ProgramArguments'],['__INSTALL_APPROVED_EXECUTABLE_PATH__','--run'])
  self.assertIs(job['RunAtLoad'],True)
  self.assertEqual(job['StartInterval'],120)
  self.assertEqual(job['StandardOutPath'],'__APPROVED_PRIVATE_LOG_PATH__')
if __name__=='__main__':unittest.main(verbosity=1)
