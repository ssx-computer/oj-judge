#include <iostream>
#include <vector>
using namespace std;

int main() {
    ios_base::sync_with_stdio(false);
    cin.tie(nullptr);
    int n,sum;
    cin>>n;
    for(int i=1;i<=n;++i){
      sum*=i;
    }
    cout<<sum;
    return 0;
}
