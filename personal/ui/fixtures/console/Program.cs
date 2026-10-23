using System.Globalization;
if (args.Length != 2 || !int.TryParse(args[0], out var left) || !int.TryParse(args[1], out var right))
{
    Console.WriteLine("입력 오류: 두 정수를 입력하세요.");
    return 2;
}
Console.WriteLine((left + right).ToString(CultureInfo.InvariantCulture));
return 0;
